import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DAEMON_CONFIG } from '../config/config.js';
import type { DaemonConfig } from '../config/config.js';
import { ProfilesService } from '../profiles/profiles.service.js';
import { LogRecord } from './session-log.js';
import { Session, SessionError, SessionRecord } from './session.js';

export interface StartRequest {
  profile: string;
  args?: string[];
  argsReplace?: string[];
  cwd?: string;
  env?: Record<string, string>;
  label?: string;
  id?: string;
}

interface RegistryEvents {
  output: [id: string, record: LogRecord];
  changed: [record: SessionRecord];
  exit: [record: SessionRecord];
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Shape checks only; the daemon never judges the content of a request. */
function validateStartRequest(req: StartRequest): void {
  const bad = (what: string) =>
    new SessionError('invalid-request', `${what} has the wrong type`);
  if (typeof req.profile !== 'string') throw bad('"profile"');
  if (req.args !== undefined && !isStringArray(req.args)) throw bad('"args"');
  if (req.argsReplace !== undefined && !isStringArray(req.argsReplace))
    throw bad('"argsReplace"');
  if (req.cwd !== undefined && typeof req.cwd !== 'string') throw bad('"cwd"');
  if (req.label !== undefined && typeof req.label !== 'string')
    throw bad('"label"');
  if (req.id !== undefined && typeof req.id !== 'string') throw bad('"id"');
  if (
    req.env !== undefined &&
    (typeof req.env !== 'object' ||
      req.env === null ||
      Array.isArray(req.env) ||
      !Object.values(req.env).every((v) => typeof v === 'string'))
  ) {
    throw bad('"env"');
  }
}

/**
 * Registry of sessions, running and exited. Owns the on-disk session
 * directory and re-emits every session's events with its id.
 */
@Injectable()
export class SessionsService
  extends EventEmitter<RegistryEvents>
  implements OnModuleInit
{
  private readonly logger = new Logger(SessionsService.name);
  private readonly sessions = new Map<string, Session>();
  private shuttingDown = false;

  constructor(
    @Inject(DAEMON_CONFIG) private readonly config: DaemonConfig,
    private readonly profiles: ProfilesService,
  ) {
    super();
  }

  get dir(): string {
    return path.join(this.config.stateDir, 'sessions');
  }

  async onModuleInit(): Promise<void> {
    fs.mkdirSync(this.dir, { recursive: true });
    await this.restoreFromDisk();
  }

  /** Any session recorded as running belonged to a previous daemon process. */
  private async restoreFromDisk(): Promise<void> {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    let orphaned = 0;
    for (const id of entries) {
      const dir = path.join(this.dir, id);
      const metaPath = path.join(dir, 'meta.json');
      try {
        const record = JSON.parse(
          fs.readFileSync(metaPath, 'utf8'),
        ) as SessionRecord;
        const session = Session.restore(dir, record);
        const wasRunning = record.state === 'running';
        if (wasRunning) {
          session.markOrphaned('daemon-restart');
          orphaned++;
        }
        // The boundary of an orphaned session, or one whose earlier recovery
        // failed, comes from the log itself.
        if (wasRunning || record.lastSeqUnverified) {
          await session.recoverLastSeq(5);
        }
        this.sessions.set(record.id, session);
      } catch (err) {
        this.logger.warn(
          `ignoring session directory ${dir}: ${(err as Error).message}`,
        );
      }
    }
    this.logger.log(
      `restored ${this.sessions.size} session(s) from ${this.dir}, ${orphaned} orphaned`,
    );
  }

  list(): SessionRecord[] {
    return [...this.sessions.values()]
      .map((s) => s.record)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  get(id: string): Session {
    const s = this.sessions.get(id);
    if (!s)
      throw new SessionError('unknown-session', `no session with id ${id}`);
    return s;
  }

  start(req: StartRequest): SessionRecord {
    if (this.shuttingDown)
      throw new SessionError('shutting-down', 'the daemon is shutting down');
    validateStartRequest(req);
    const profile = this.profiles.get(req.profile);
    if (!profile)
      throw new SessionError(
        'unknown-profile',
        `no profile named ${req.profile}`,
      );
    const id = req.id ?? randomUUID();
    if (!ID_RE.test(id))
      throw new SessionError(
        'invalid-id',
        'session id must match ' + ID_RE.source,
      );
    if (this.sessions.has(id))
      throw new SessionError('duplicate-id', `session ${id} already exists`);

    const session = Session.start(
      this.dir,
      {
        id,
        profile: profile.name,
        label: req.label ?? null,
        command: profile.command,
        args: req.argsReplace ?? [...profile.args, ...(req.args ?? [])],
        cwd: req.cwd ?? profile.cwd ?? process.cwd(),
        env: { ...profile.env, ...req.env },
        loginShell: profile.loginShell,
      },
      {
        maxLineBytes: this.config.maxLineBytes,
        stdinBufferBytes: this.config.slowConsumerBytes,
        pipeGraceMs: this.config.pipeGraceMs,
      },
    );
    this.sessions.set(id, session);
    session.on('output', (record) => this.emit('output', id, record));
    session.on('exit', (record) => {
      this.logger.log(
        `session ${id} exited code=${record.exitCode} signal=${record.signal}`,
      );
      this.emit('exit', record);
      this.emit('changed', record);
    });
    this.logger.log(
      `session ${id} started: ${profile.name} pid=${session.record.pid}`,
    );
    this.emit('changed', session.record);
    return session.record;
  }

  remove(id: string): void {
    const session = this.get(id);
    session.remove();
    this.sessions.delete(id);
  }

  /**
   * Shutdown: SIGTERM every running child, wait up to `graceMs` for them to
   * exit, SIGKILL the rest, and wait briefly again so their records are
   * written as exited rather than left for the next start to mark.
   */
  async terminateAll(graceMs = 5000): Promise<void> {
    this.shuttingDown = true;
    const running = () =>
      [...this.sessions.values()].filter((s) => s.record.state === 'running');
    for (const s of running()) {
      try {
        s.terminate('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    await Promise.all(running().map((s) => s.waitForExit(graceMs)));
    const stubborn = running();
    for (const s of stubborn) {
      this.logger.warn(
        `session ${s.record.id} ignored SIGTERM; sending SIGKILL`,
      );
      try {
        s.terminate('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    await Promise.all(stubborn.map((s) => s.waitForExit(2000)));
  }
}
