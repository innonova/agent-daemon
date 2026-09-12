import { Logger } from '@nestjs/common';
import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { LineSplitter } from './line-splitter.js';
import { LogIndex, LogRecord, LogStream, SessionLog } from './session-log.js';

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
  /** Pid of the child; kept after exit for correlation, null if never spawned. */
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

export interface SessionLimits {
  /** Upper bound for one stdout/stderr line. */
  maxLineBytes: number;
  /** Unwritten stdin bytes after which input is refused. */
  stdinBufferBytes: number;
  /** After exit, how long inherited pipes may stay open before being closed. */
  pipeGraceMs: number;
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
  private static readonly logger = new Logger(Session.name);
  readonly record: SessionRecord;
  readonly index = new LogIndex();
  private child: ChildProcess | null = null;
  private log: SessionLog | null = null;
  private logFailing = false;
  private stdinOpen = false;
  private stdinLimit = Infinity;
  private pipeGrace: NodeJS.Timeout | null = null;
  private writes: Promise<void> = Promise.resolve();

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

  /**
   * Creates the session directory and spawns the child. The initial record
   * must reach disk before the session is reported as started, so that a
   * daemon restart can always account for it.
   */
  static start(
    baseDir: string,
    spec: SpawnSpec,
    limits: SessionLimits,
  ): Session {
    const dir = path.join(baseDir, spec.id);
    if (fs.existsSync(dir))
      throw new SessionError(
        'duplicate-id',
        `session directory ${dir} already exists`,
      );
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
    try {
      fs.mkdirSync(dir, { recursive: true });
      session.log = new SessionLog(session.logPath, session.index);
      session.writeMeta();
    } catch (err) {
      session.log?.close();
      fs.rmSync(dir, { recursive: true, force: true });
      throw new SessionError(
        'storage-error',
        `cannot create session on disk: ${(err as Error).message}`,
      );
    }
    session.spawn(limits);
    session.saveMeta();
    return session;
  }

  /** Rehydrates a session found on disk at startup. It is never running. */
  static restore(dir: string, record: SessionRecord): Session {
    return new Session(dir, record);
  }

  private spawn(limits: SessionLimits): void {
    const r = this.record;
    const env = { ...process.env, ...r.env };
    this.stdinLimit = limits.stdinBufferBytes;
    let child: ChildProcess;
    try {
      child = this.spawnChild(env);
    } catch (err) {
      // Synchronous spawn failures (a cwd that is a file, bad argument
      // types) become an ordinary exit, deferred so the registry has
      // attached its listeners by the time the events fire.
      setImmediate(() => {
        this.emitRecord('err', `agent-daemon: ${(err as Error).message}`);
        this.finish(null, null, `spawn-error: ${(err as Error).message}`);
      });
      return;
    }
    this.child = child;
    this.stdinOpen = true;
    r.pid = child.pid ?? null;

    const splitterFor = (stream: LogStream) =>
      new LineSplitter(
        limits.maxLineBytes,
        (line) => this.emitRecord(stream, line),
        (dropped) => {
          const name = stream === 'out' ? 'stdout' : 'stderr';
          this.emitRecord(
            'err',
            dropped === null
              ? `agent-daemon: line on ${name} exceeds ${limits.maxLineBytes} bytes; dropping it`
              : `agent-daemon: dropped ${dropped} bytes exceeding line limit on ${name}`,
          );
        },
      );
    const out = splitterFor('out');
    const err = splitterFor('err');
    child.stdout!.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => err.push(chunk));
    child.stdout!.on('end', () => out.flush());
    child.stderr!.on('end', () => err.flush());
    child.stdin!.on('error', () => {
      /* surfaced per write through the write callback */
    });
    child.stdin!.on('close', () => {
      this.stdinOpen = false;
    });

    let spawnError: Error | null = null;
    child.on('error', (e) => {
      spawnError = e;
      this.emitRecord('err', `agent-daemon: ${e.message}`);
    });
    // 'exit' fires when the process is gone; 'close' when its stdio has also
    // ended. A descendant that inherited the pipes can hold them open, so
    // after a grace period we destroy the streams ourselves.
    child.on('exit', () => {
      this.pipeGrace = setTimeout(() => {
        this.pipeGrace = null;
        Session.logger.warn(
          `session ${r.id}: pipes still open ${limits.pipeGraceMs}ms after exit; closing them`,
        );
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, limits.pipeGraceMs);
    });
    child.on('close', (code, signal) => {
      if (this.pipeGrace) clearTimeout(this.pipeGrace);
      this.pipeGrace = null;
      this.finish(
        code,
        signal,
        spawnError ? `spawn-error: ${spawnError.message}` : null,
      );
    });
  }

  /**
   * With `loginShell` the command line is prefixed with `exec` so the shell
   * replaces itself with the agent: signals and exit status then refer to
   * the agent, not to a shell wrapping it.
   */
  private spawnChild(env: NodeJS.ProcessEnv): ChildProcess {
    const r = this.record;
    const stdio: ['pipe', 'pipe', 'pipe'] = ['pipe', 'pipe', 'pipe'];
    if (r.loginShell) {
      const line = 'exec ' + [r.command, ...r.args].map(shellQuote).join(' ');
      return spawn(process.env.SHELL || '/bin/sh', ['-lc', line], {
        cwd: r.cwd,
        env,
        stdio,
      });
    }
    return spawn(r.command, r.args, { cwd: r.cwd, env, stdio });
  }

  private emitRecord(s: LogStream, d: string): void {
    const record: LogRecord = {
      seq: ++this.record.lastSeq,
      t: Date.now(),
      s,
      d,
    };
    this.persist(record);
    this.emit('output', record);
  }

  /**
   * Disk trouble must not take the daemon or the session down: the record
   * is still delivered live, every later append is retried, and clients are
   * told when logging fails and when it recovers, so they know replay has a
   * hole.
   */
  private persist(record: LogRecord): void {
    if (!this.log) return;
    try {
      this.log.append(record);
      if (this.logFailing) {
        this.logFailing = false;
        Session.logger.log(`session ${this.record.id}: log writes recovered`);
        this.emitRecord(
          'err',
          `agent-daemon: log writes recovered; records before seq ${record.seq} may be missing from replay`,
        );
      }
    } catch (err) {
      if (!this.logFailing) {
        this.logFailing = true;
        Session.logger.error(
          `session ${this.record.id}: log write failed: ${(err as Error).message}`,
        );
        this.emitRecord(
          'err',
          `agent-daemon: log write failed (${(err as Error).message}); replay will be incomplete`,
        );
      }
    }
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

  /**
   * Writes one line to the child's stdin and records it. Resolves once the
   * bytes have been handed to the pipe, rejects if the pipe fails first.
   * Refuses input while more than `stdinBufferBytes` are still unwritten.
   */
  input(line: string): Promise<void> {
    if (this.record.state !== 'running' || !this.child)
      throw new SessionError('session-not-running', 'session is not running');
    const stdin = this.child.stdin;
    if (!this.stdinOpen || !stdin || stdin.destroyed || stdin.writableEnded) {
      throw new SessionError('stdin-closed', 'stdin is closed');
    }
    if (stdin.writableLength > this.stdinLimit) {
      throw new SessionError(
        'stdin-full',
        'the process is not reading its stdin; input refused',
      );
    }
    this.emitRecord('in', line);
    const write = new Promise<void>((resolve, reject) => {
      stdin.write(line + '\n', (err) => {
        if (!err) return resolve();
        this.emitRecord(
          'err',
          `agent-daemon: stdin write failed: ${err.message}`,
        );
        reject(
          new SessionError('stdin-error', `stdin write failed: ${err.message}`),
        );
      });
    });
    // Serialise completion so callers observe results in write order.
    const chained = this.writes.then(() => write);
    this.writes = chained.catch(() => undefined);
    return chained;
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

  /** Waits for the session to exit, at most `ms`. Resolves true if it did. */
  waitForExit(ms: number): Promise<boolean> {
    if (this.record.state === 'exited') return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off('exit', done);
        resolve(false);
      }, ms);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.once('exit', done);
    });
  }

  /** Marks an orphaned session (found running on disk at daemon start) as exited. */
  markOrphaned(reason: string, lastSeq: number): void {
    const r = this.record;
    if (r.state === 'exited') return;
    r.state = 'exited';
    r.exitReason = reason;
    r.exitedAt = Date.now();
    r.lastSeq = lastSeq;
    this.saveMeta();
  }

  private writeMeta(): void {
    const tmp = this.metaPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.record, null, 2));
    fs.renameSync(tmp, this.metaPath);
  }

  saveMeta(): void {
    try {
      this.writeMeta();
    } catch (err) {
      Session.logger.error(
        `session ${this.record.id}: could not write meta.json: ${(err as Error).message}`,
      );
    }
  }

  /** Deletes everything on disk. Only valid once exited. */
  remove(): void {
    if (this.record.state !== 'exited')
      throw new SessionError('session-running', 'session is still running');
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  /** Records `fromSeq..untilSeq` from disk, seeking via the index. */
  read(fromSeq: number, untilSeq: number): AsyncGenerator<LogRecord> {
    return SessionLog.read(
      this.logPath,
      fromSeq,
      untilSeq,
      this.index.offsetFor(fromSeq),
      this.index,
    );
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
