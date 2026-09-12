import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { LineSplitter } from './line-splitter.js';
import { LogRecord, LogStream, SessionLog } from './session-log.js';

export type SessionState = 'running' | 'exited';

/** Persisted as `meta.json`; also what clients see. */
export interface SessionRecord {
  id: string;
  profile: string;
  label: string | null;
  command: string;
  args: string[];
  cwd: string;
  /** Only the overlay applied on top of the daemon's environment. */
  env: Record<string, string>;
  loginShell: boolean;
  pid: number | null;
  state: SessionState;
  exitCode: number | null;
  signal: string | null;
  /** Set when the exit was not the process' own doing, e.g. `daemon-restart`. */
  exitReason: string | null;
  startedAt: number;
  exitedAt: number | null;
  lastSeq: number;
}

export interface SpawnSpec {
  id: string;
  profile: string;
  label: string | null;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  loginShell: boolean;
}

export interface SessionEvents {
  output: [record: LogRecord];
  exit: [record: SessionRecord];
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * One child process plus its log. Forwards lines both ways and records
 * them; attaches no meaning to their content.
 */
export class Session extends EventEmitter<SessionEvents> {
  readonly record: SessionRecord;
  private child: ChildProcess | null = null;
  private log: SessionLog | null = null;
  private stdinOpen = false;

  constructor(
    readonly dir: string,
    record: SessionRecord,
  ) {
    super();
    this.record = record;
  }

  get metaPath(): string {
    return path.join(this.dir, 'meta.json');
  }

  get logPath(): string {
    return path.join(this.dir, 'log.ndjson');
  }

  /** Creates the session directory and spawns the child. */
  static start(
    baseDir: string,
    spec: SpawnSpec,
    maxLineBytes: number,
  ): Session {
    const dir = path.join(baseDir, spec.id);
    fs.mkdirSync(dir, { recursive: true });
    const record: SessionRecord = {
      ...spec,
      pid: null,
      state: 'running',
      exitCode: null,
      signal: null,
      exitReason: null,
      startedAt: Date.now(),
      exitedAt: null,
      lastSeq: 0,
    };
    const session = new Session(dir, record);
    session.log = new SessionLog(session.logPath);
    session.spawn(maxLineBytes);
    session.saveMeta();
    return session;
  }

  /** Rehydrates a session found on disk at startup. It is never running. */
  static restore(dir: string, record: SessionRecord): Session {
    return new Session(dir, record);
  }

  private spawn(maxLineBytes: number): void {
    const r = this.record;
    const env = { ...process.env, ...r.env };
    const child = r.loginShell
      ? spawn(
          process.env.SHELL || '/bin/sh',
          ['-lc', [r.command, ...r.args].map(shellQuote).join(' ')],
          {
            cwd: r.cwd,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        )
      : spawn(r.command, r.args, {
          cwd: r.cwd,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
    this.child = child;
    this.stdinOpen = true;
    r.pid = child.pid ?? null;

    const splitterFor = (stream: LogStream) =>
      new LineSplitter(
        maxLineBytes,
        (line) => this.emitRecord(stream, line),
        (dropped) =>
          this.emitRecord(
            'err',
            `agent-daemon: dropped ${dropped} bytes exceeding line limit on ${stream === 'out' ? 'stdout' : 'stderr'}`,
          ),
      );
    const out = splitterFor('out');
    const err = splitterFor('err');
    child.stdout!.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => err.push(chunk));
    child.stdout!.on('end', () => out.flush());
    child.stderr!.on('end', () => err.flush());
    child.stdin!.on('error', () => {
      /* EPIPE after the child exits; the exit path reports state */
    });
    child.stdin!.on('close', () => {
      this.stdinOpen = false;
    });

    let spawnError: Error | null = null;
    child.on('error', (e) => {
      spawnError = e;
      this.emitRecord('err', `agent-daemon: ${e.message}`);
    });
    // 'close' fires after exit *and* after all stdio streams have ended, so
    // every line has been emitted by the time we record the exit.
    child.on('close', (code, signal) => {
      this.finish(
        code,
        signal,
        spawnError ? `spawn-error: ${spawnError.message}` : null,
      );
    });
  }

  private emitRecord(s: LogStream, d: string): void {
    const record: LogRecord = {
      seq: ++this.record.lastSeq,
      t: Date.now(),
      s,
      d,
    };
    this.log?.append(record);
    this.emit('output', record);
  }

  private finish(
    code: number | null,
    signal: NodeJS.Signals | null,
    reason: string | null,
  ): void {
    const r = this.record;
    if (r.state === 'exited') return;
    r.state = 'exited';
    r.exitCode = code;
    r.signal = signal;
    r.exitReason = reason;
    r.exitedAt = Date.now();
    this.child = null;
    this.saveMeta();
    this.log?.close();
    this.log = null;
    this.emit('exit', r);
  }

  /** Writes one line to the child's stdin and records it. */
  input(line: string): void {
    if (this.record.state !== 'running' || !this.child)
      throw new SessionError('session-not-running', 'session is not running');
    if (!this.stdinOpen || !this.child.stdin || this.child.stdin.destroyed) {
      throw new SessionError('stdin-closed', 'stdin is closed');
    }
    this.emitRecord('in', line);
    this.child.stdin.write(line + '\n');
  }

  endInput(): void {
    if (this.record.state !== 'running' || !this.child)
      throw new SessionError('session-not-running', 'session is not running');
    if (this.stdinOpen) {
      this.stdinOpen = false;
      this.child.stdin?.end();
    }
  }

  signal(sig: NodeJS.Signals): void {
    if (this.record.state !== 'running' || !this.child)
      throw new SessionError('session-not-running', 'session is not running');
    this.child.kill(sig);
  }

  /** Marks an orphaned session (found running on disk at daemon start) as exited. */
  markOrphaned(reason: string): void {
    const r = this.record;
    if (r.state === 'exited') return;
    r.state = 'exited';
    r.exitReason = reason;
    r.exitedAt = Date.now();
    r.pid = null;
    this.saveMeta();
  }

  saveMeta(): void {
    const tmp = this.metaPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.record, null, 2));
    fs.renameSync(tmp, this.metaPath);
  }

  /** Deletes everything on disk. Only valid once exited. */
  remove(): void {
    if (this.record.state !== 'exited')
      throw new SessionError('session-running', 'session is still running');
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  read(fromSeq: number): AsyncGenerator<LogRecord> {
    return SessionLog.read(this.logPath, fromSeq);
  }
}

export class SessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
