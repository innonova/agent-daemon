import { Inject, Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { createRequire } from 'node:module';
import type { WebSocket } from 'ws';
import { DAEMON_CONFIG, PROTOCOL_VERSION } from '../config/config.js';
import type { DaemonConfig } from '../config/config.js';
import { toPublicProfile } from '../profiles/profile.js';
import { ProfilesService } from '../profiles/profiles.service.js';
import type { LogRecord } from '../sessions/session-log.js';
import { SessionError } from '../sessions/session.js';
import type { SessionRecord } from '../sessions/session.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { CLIENT_FRAME_TYPES } from './protocol.js';
import type {
  ClientFrames,
  DaemonFrame,
  Ref,
  ReplayOption,
} from './protocol.js';

const require = createRequire(import.meta.url);
const VERSION: string = (require('../../package.json') as { version: string })
  .version;

/** Maps our `{type, ...}` frames onto Nest's `{event, data}` convention. */
export function messageParser(data: unknown): { event: string; data: unknown } {
  let frame: unknown;
  try {
    frame = JSON.parse(String(data));
  } catch {
    return { event: '__malformed', data: { reason: 'not valid JSON' } };
  }
  if (
    typeof frame !== 'object' ||
    frame === null ||
    typeof (frame as { type?: unknown }).type !== 'string'
  ) {
    return {
      event: '__malformed',
      data: { reason: 'frame must be an object with a string "type"', frame },
    };
  }
  const type = (frame as { type: string }).type;
  if (!(CLIENT_FRAME_TYPES as readonly string[]).includes(type)) {
    return { event: '__unknown', data: frame };
  }
  return { event: type, data: frame };
}

type Attachment =
  { state: 'replaying'; buffer: LogRecord[] } | { state: 'live' };

interface Connection {
  attachments: Map<string, Attachment>;
}

type Frame<K extends keyof ClientFrames> = ClientFrames[K] & { ref?: Ref };

@WebSocketGateway({ path: '/' })
export class AgentGateway
  implements
    OnGatewayInit,
    OnGatewayConnection<WebSocket>,
    OnGatewayDisconnect<WebSocket>
{
  private readonly logger = new Logger(AgentGateway.name);
  private readonly connections = new Map<WebSocket, Connection>();
  /** session id -> clients attached to it */
  private readonly attached = new Map<string, Set<WebSocket>>();

  constructor(
    @Inject(DAEMON_CONFIG) private readonly config: DaemonConfig,
    private readonly profiles: ProfilesService,
    private readonly sessions: SessionsService,
  ) {}

  afterInit(): void {
    this.sessions.on('output', (id, record) => this.onOutput(id, record));
    this.sessions.on('changed', (session) =>
      this.broadcast({ type: 'session.changed', session }),
    );
    this.sessions.on('exit', (r) =>
      this.broadcast({
        type: 'session.exit',
        id: r.id,
        exitCode: r.exitCode,
        signal: r.signal,
        exitReason: r.exitReason,
        exitedAt: r.exitedAt,
      }),
    );
    this.profiles.onChange((profiles) =>
      this.broadcast({
        type: 'profiles.changed',
        profiles: profiles.map(toPublicProfile),
      }),
    );
  }

  handleConnection(client: WebSocket): void {
    this.connections.set(client, { attachments: new Map() });
  }

  handleDisconnect(client: WebSocket): void {
    this.detachAll(client);
    this.connections.delete(client);
  }

  // ---- requests -----------------------------------------------------------

  @SubscribeMessage('hello')
  hello(@MessageBody() f: Frame<'hello'>): DaemonFrame {
    if (f.protocol !== PROTOCOL_VERSION) {
      return this.error(
        f.ref,
        'unsupported-protocol',
        `this daemon speaks protocol ${PROTOCOL_VERSION}`,
      );
    }
    return {
      type: 'welcome',
      ref: f.ref,
      protocol: PROTOCOL_VERSION,
      version: VERSION,
      profiles: this.profiles.list().map(toPublicProfile),
      sessions: this.sessions.list(),
    };
  }

  @SubscribeMessage('profiles.list')
  profilesList(@MessageBody() f: Frame<'profiles.list'>): DaemonFrame {
    return {
      type: 'profiles',
      ref: f.ref,
      profiles: this.profiles.list().map(toPublicProfile),
    };
  }

  @SubscribeMessage('profiles.reload')
  async profilesReload(
    @MessageBody() f: Frame<'profiles.reload'>,
  ): Promise<DaemonFrame> {
    const profiles = await this.profiles.reload();
    return {
      type: 'profiles',
      ref: f.ref,
      profiles: profiles.map(toPublicProfile),
    };
  }

  @SubscribeMessage('sessions.list')
  sessionsList(@MessageBody() f: Frame<'sessions.list'>): DaemonFrame {
    return { type: 'sessions', ref: f.ref, sessions: this.sessions.list() };
  }

  @SubscribeMessage('session.get')
  sessionGet(@MessageBody() f: Frame<'session.get'>): DaemonFrame {
    return this.guard(f, () => ({
      type: 'session',
      ref: f.ref,
      session: this.sessions.get(f.id).record,
    }));
  }

  @SubscribeMessage('session.start')
  async sessionStart(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() f: Frame<'session.start'>,
  ): Promise<DaemonFrame> {
    let session: SessionRecord;
    try {
      session = this.sessions.start(f);
    } catch (err) {
      return this.errorFrom(f.ref, err);
    }
    if (f.attach) {
      await this.attach(client, session.id, f.replay ?? false);
    }
    return { type: 'session.started', ref: f.ref, session };
  }

  @SubscribeMessage('session.attach')
  async sessionAttach(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() f: Frame<'session.attach'>,
  ): Promise<DaemonFrame> {
    try {
      const lastSeq = await this.attach(client, f.id, f.replay ?? false);
      return {
        type: 'session.attached',
        ref: f.ref,
        session: this.sessions.get(f.id).record,
        lastSeq,
      };
    } catch (err) {
      return this.errorFrom(f.ref, err, f.id);
    }
  }

  @SubscribeMessage('session.detach')
  sessionDetach(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() f: Frame<'session.detach'>,
  ): DaemonFrame {
    this.detach(client, f.id);
    return { type: 'session.detached', ref: f.ref, id: f.id };
  }

  @SubscribeMessage('session.input')
  sessionInput(@MessageBody() f: Frame<'session.input'>): DaemonFrame {
    return this.guard(f, () => {
      const line = typeof f.data === 'string' ? f.data : JSON.stringify(f.data);
      if (line === undefined)
        throw new SessionError('invalid-input', '"data" is required');
      this.sessions.get(f.id).input(line);
      return { type: 'ok', ref: f.ref };
    });
  }

  @SubscribeMessage('session.signal')
  sessionSignal(@MessageBody() f: Frame<'session.signal'>): DaemonFrame {
    return this.guard(f, () => {
      if (!['SIGINT', 'SIGTERM', 'SIGKILL'].includes(f.signal)) {
        throw new SessionError(
          'invalid-signal',
          'signal must be SIGINT, SIGTERM or SIGKILL',
        );
      }
      this.sessions.get(f.id).signal(f.signal);
      return { type: 'ok', ref: f.ref };
    });
  }

  @SubscribeMessage('session.end-input')
  sessionEndInput(@MessageBody() f: Frame<'session.end-input'>): DaemonFrame {
    return this.guard(f, () => {
      this.sessions.get(f.id).endInput();
      return { type: 'ok', ref: f.ref };
    });
  }

  @SubscribeMessage('session.remove')
  sessionRemove(@MessageBody() f: Frame<'session.remove'>): DaemonFrame {
    return this.guard(f, () => {
      this.sessions.remove(f.id);
      for (const client of this.attached.get(f.id) ?? []) {
        this.connections.get(client)?.attachments.delete(f.id);
      }
      this.attached.delete(f.id);
      return { type: 'ok', ref: f.ref };
    });
  }

  @SubscribeMessage('__unknown')
  unknown(@MessageBody() f: { type: string; ref?: Ref }): DaemonFrame {
    return this.error(f.ref, 'unknown-type', `unknown frame type "${f.type}"`);
  }

  @SubscribeMessage('__malformed')
  malformed(
    @MessageBody() f: { reason: string; frame?: { ref?: Ref } },
  ): DaemonFrame {
    return this.error(f.frame?.ref, 'malformed', f.reason);
  }

  // ---- attachment & output ------------------------------------------------

  /**
   * Attaches `client` to a session, optionally replaying the log first.
   * Live output arriving during replay is buffered and flushed afterwards,
   * so the client sees a contiguous `seq`. Returns the last seq sent.
   */
  private async attach(
    client: WebSocket,
    id: string,
    replay: ReplayOption,
  ): Promise<number> {
    const session = this.sessions.get(id);
    const conn = this.connections.get(client);
    if (!conn) throw new SessionError('closed', 'connection is closed');
    if (conn.attachments.has(id)) {
      // Re-attaching is a no-op unless replay is requested; then detach and redo.
      if (!replay) return session.record.lastSeq;
      this.detach(client, id);
    }
    const fromSeq =
      replay === true
        ? 1
        : replay === false
          ? Number.MAX_SAFE_INTEGER
          : Math.max(1, replay.fromSeq);
    const attachment: Attachment = replay
      ? { state: 'replaying', buffer: [] }
      : { state: 'live' };
    conn.attachments.set(id, attachment);
    let set = this.attached.get(id);
    if (!set) this.attached.set(id, (set = new Set()));
    set.add(client);

    let lastSeq = fromSeq - 1;
    if (attachment.state === 'replaying') {
      try {
        for await (const record of session.read(fromSeq)) {
          if (conn.attachments.get(id) !== attachment) return lastSeq; // detached meanwhile
          await this.waitForDrain(client);
          this.send(client, { type: 'session.output', id, ...record });
          lastSeq = record.seq;
        }
        if (conn.attachments.get(id) !== attachment) return lastSeq;
        for (const record of attachment.buffer) {
          if (record.seq > lastSeq) {
            this.send(client, { type: 'session.output', id, ...record });
            lastSeq = record.seq;
          }
        }
      } finally {
        if (conn.attachments.get(id) === attachment)
          conn.attachments.set(id, { state: 'live' });
      }
    } else {
      lastSeq = session.record.lastSeq;
    }
    return lastSeq;
  }

  private detach(client: WebSocket, id: string): void {
    this.connections.get(client)?.attachments.delete(id);
    const set = this.attached.get(id);
    if (set) {
      set.delete(client);
      if (set.size === 0) this.attached.delete(id);
    }
  }

  private detachAll(client: WebSocket): void {
    const conn = this.connections.get(client);
    if (!conn) return;
    const ids = Array.from(conn.attachments.keys()); // detach mutates the map
    for (const id of ids) this.detach(client, id);
  }

  private onOutput(id: string, record: LogRecord): void {
    const clients = this.attached.get(id);
    if (!clients) return;
    for (const client of clients) {
      const attachment = this.connections.get(client)?.attachments.get(id);
      if (!attachment) continue;
      if (attachment.state === 'replaying') {
        attachment.buffer.push(record);
        continue;
      }
      if (client.bufferedAmount > this.config.slowConsumerBytes) {
        this.logger.warn(
          `detaching slow consumer (${client.bufferedAmount} bytes queued)`,
        );
        this.detachAll(client);
        this.send(client, {
          type: 'error',
          code: 'slow-consumer',
          message:
            'client is not reading fast enough; detached from all sessions',
        });
        continue;
      }
      this.send(client, { type: 'session.output', id, ...record });
    }
  }

  /** Replay is pull-based, so instead of dropping we wait for the socket to drain. */
  private async waitForDrain(client: WebSocket): Promise<void> {
    const limit = this.config.slowConsumerBytes / 4;
    while (client.bufferedAmount > limit && client.readyState === client.OPEN) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  // ---- helpers ------------------------------------------------------------

  private send(client: WebSocket, frame: DaemonFrame): void {
    if (client.readyState === client.OPEN) client.send(JSON.stringify(frame));
  }

  private broadcast(frame: DaemonFrame): void {
    const data = JSON.stringify(frame);
    for (const client of this.connections.keys()) {
      if (client.readyState === client.OPEN) client.send(data);
    }
  }

  private guard(
    f: { ref?: Ref; id?: string },
    fn: () => DaemonFrame,
  ): DaemonFrame {
    try {
      return fn();
    } catch (err) {
      return this.errorFrom(f.ref, err, f.id);
    }
  }

  private errorFrom(
    ref: Ref | undefined,
    err: unknown,
    id?: string,
  ): DaemonFrame {
    if (err instanceof SessionError)
      return this.error(ref, err.code, err.message, id);
    this.logger.error(err);
    return this.error(
      ref,
      'internal',
      (err as Error).message ?? String(err),
      id,
    );
  }

  private error(
    ref: Ref | undefined,
    code: string,
    message: string,
    id?: string,
  ): DaemonFrame {
    return { type: 'error', ref, id, code, message };
  }
}
