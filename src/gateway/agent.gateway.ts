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

interface Attachment {
  state: 'replaying' | 'live';
}

interface Connection {
  attachments: Map<string, Attachment>;
}

type Frame<K extends keyof ClientFrames> = ClientFrames[K] & { ref?: Ref };

/**
 * The websocket side of the protocol. Every frame leaving the daemon goes
 * through `send`, which enforces the slow-consumer bound; handlers return
 * nothing to Nest so its own envelope never reaches a client.
 */
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
  hello(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() f: Frame<'hello'>,
  ): void {
    this.handle(client, f, () => {
      if (f.protocol !== PROTOCOL_VERSION) {
        throw new SessionError(
          'unsupported-protocol',
          `this daemon speaks protocol ${PROTOCOL_VERSION}`,
        );
      }
      return {
        type: 'welcome',
        protocol: PROTOCOL_VERSION,
        version: VERSION,
        profiles: this.profiles.list().map(toPublicProfile),
        sessions: this.sessions.list(),
      };
    });
  }

  @SubscribeMessage('profiles.list')
  profilesList(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() f: Frame<'profiles.list'>,
  ): void {
    this.handle(client, f, () => ({
      type: 'profiles',
      profiles: this.profiles.list().map(toPublicProfile),
    }));
  }

  @SubscribeMessage('profiles.reload')
  profilesReload(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() f: Frame<'profiles.reload'>,
  ): void {
    this.handle(client, f, async () => ({
      type: 'profiles',
      profiles: (await this.profiles.reload()).map(toPublicProfile),
    }));
  }

  @SubscribeMessage('sessions.list')
  sessionsList(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() f: Frame<'sessions.list'>,
  ): void {
    this.handle(client, f, () => ({
      type: 'sessions',
      sessions: this.sessions.list(),
    }));
  }

  @SubscribeMessage('session.get')
  sessionGet(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() f: Frame<'session.get'>,
  ): void {
    this.handle(client, f, () => ({
      type: 'session',
      session: this.sessions.get(f.id).record,
    }));
  }

  @SubscribeMessage('session.start')
  sessionStart(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() f: Frame<'session.start'>,
  ): void {
    this.handle(client, f, async () => {
      const replay = this.parseReplay(f.replay);
      if (f.attach !== undefined && typeof f.attach !== 'boolean') {
        throw new SessionError('invalid-request', '"attach" must be a boolean');
      }
      const session = this.sessions.start(f);
      if (!f.attach) return { type: 'session.started', session };
      // The session exists whatever happens to the attachment, so the reply
      // is always session.started; the attach outcome rides along.
      try {
        const result = await this.attach(client, session.id, replay);
        if (result === null)
          throw new SessionError(
            'cancelled',
            'attachment was cancelled before it completed',
          );
        return {
          type: 'session.started',
          session: this.sessions.get(session.id).record,
          attached: true,
        };
      } catch (err) {
        const code = err instanceof SessionError ? err.code : 'internal';
        return {
          type: 'session.started',
          session,
          attached: false,
          attachError: { code, message: (err as Error).message },
        };
      }
    });
  }

  @SubscribeMessage('session.attach')
  sessionAttach(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() f: Frame<'session.attach'>,
  ): void {
    this.handle(client, f, async () => {
      const lastSeq = await this.attach(
        client,
        f.id,
        this.parseReplay(f.replay),
      );
      if (lastSeq === null)
        throw new SessionError(
          'cancelled',
          'attachment was cancelled before it completed',
        );
      return {
        type: 'session.attached',
        session: this.sessions.get(f.id).record,
        lastSeq,
      };
    });
  }

  @SubscribeMessage('session.detach')
  sessionDetach(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() f: Frame<'session.detach'>,
  ): void {
    this.handle(client, f, () => {
      this.detach(client, f.id);
      return { type: 'session.detached', id: f.id };
    });
  }

  @SubscribeMessage('session.input')
  sessionInput(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() f: Frame<'session.input'>,
  ): void {
    this.handle(client, f, async () => {
      const line = typeof f.data === 'string' ? f.data : JSON.stringify(f.data);
      if (line === undefined)
        throw new SessionError('invalid-input', '"data" is required');
      await this.sessions.get(f.id).input(line);
      return { type: 'ok' };
    });
  }

  @SubscribeMessage('session.signal')
  sessionSignal(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() f: Frame<'session.signal'>,
  ): void {
    this.handle(client, f, () => {
      if (!['SIGINT', 'SIGTERM', 'SIGKILL'].includes(f.signal)) {
        throw new SessionError(
          'invalid-signal',
          'signal must be SIGINT, SIGTERM or SIGKILL',
        );
      }
      this.sessions.get(f.id).signal(f.signal);
      return { type: 'ok' };
    });
  }

  @SubscribeMessage('session.end-input')
  sessionEndInput(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() f: Frame<'session.end-input'>,
  ): void {
    this.handle(client, f, () => {
      this.sessions.get(f.id).endInput();
      return { type: 'ok' };
    });
  }

  @SubscribeMessage('session.remove')
  sessionRemove(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() f: Frame<'session.remove'>,
  ): void {
    this.handle(client, f, () => {
      this.sessions.remove(f.id);
      for (const other of this.attached.get(f.id) ?? []) {
        this.connections.get(other)?.attachments.delete(f.id);
      }
      this.attached.delete(f.id);
      this.broadcast({ type: 'session.removed', id: f.id });
      return { type: 'ok' };
    });
  }

  @SubscribeMessage('__unknown')
  unknown(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() f: { type: string; ref?: Ref },
  ): void {
    this.send(client, {
      type: 'error',
      ref: f.ref,
      code: 'unknown-type',
      message: `unknown frame type "${f.type}"`,
    });
  }

  @SubscribeMessage('__malformed')
  malformed(
    @ConnectedSocket() client: WebSocket,
    @MessageBody() f: { reason: string; frame?: { ref?: Ref } },
  ): void {
    this.send(client, {
      type: 'error',
      ref: f.frame?.ref,
      code: 'malformed',
      message: f.reason,
    });
  }

  // ---- attachment & output ------------------------------------------------

  private parseReplay(replay: unknown): ReplayOption {
    if (replay === undefined || replay === false) return false;
    if (replay === true) return true;
    if (
      typeof replay === 'object' &&
      replay !== null &&
      Number.isSafeInteger((replay as { fromSeq?: unknown }).fromSeq)
    ) {
      return { fromSeq: (replay as { fromSeq: number }).fromSeq };
    }
    throw new SessionError(
      'invalid-request',
      '"replay" must be a boolean or { fromSeq: integer }',
    );
  }

  /**
   * Attaches `client` to a session. With replay, the log is read from disk
   * in rounds until the reader has caught up with the session's `lastSeq`,
   * at which point the attachment switches to live output in the same
   * synchronous step, so nothing is skipped or duplicated and nothing is
   * buffered in memory. Returns the last seq delivered (or the session's
   * boundary when nothing was), or null if the attachment was cancelled by
   * a detach, a re-attach or a disconnect while replaying.
   */
  private async attach(
    client: WebSocket,
    id: string,
    replay: ReplayOption,
  ): Promise<number | null> {
    const session = this.sessions.get(id);
    const conn = this.connections.get(client);
    if (!conn) throw new SessionError('closed', 'connection is closed');
    if (conn.attachments.has(id)) {
      if (!replay) return session.record.lastSeq;
      this.detach(client, id);
    }
    const attachment: Attachment = { state: replay ? 'replaying' : 'live' };
    conn.attachments.set(id, attachment);
    let set = this.attached.get(id);
    if (!set) this.attached.set(id, (set = new Set()));
    set.add(client);
    const alive = () =>
      conn.attachments.get(id) === attachment &&
      client.readyState === client.OPEN;

    if (!replay) return session.record.lastSeq;

    try {
      await session.ensureReplayable();
    } catch (err) {
      if (!alive()) return null;
      this.detach(client, id);
      throw err;
    }
    if (!alive()) return null;

    let next = replay === true ? 1 : Math.max(1, replay.fromSeq);
    let lastSent = Math.min(next - 1, session.record.lastSeq);
    try {
      for (;;) {
        const target = session.record.lastSeq;
        if (next > target) {
          // Synchronous with the check: no record can be emitted in between.
          attachment.state = 'live';
          return lastSent;
        }
        for await (const record of session.read(next, target, () => !alive())) {
          if (!alive()) return null;
          await this.waitForDrain(client, alive);
          if (!alive()) return null;
          this.send(client, { type: 'session.output', id, ...record });
          lastSent = record.seq;
          next = record.seq + 1;
        }
        if (!alive()) return null;
        // Fewer records on disk than seq handed out: logging failed at some
        // point. The hole is unavoidable; move past it.
        if (next <= target) next = target + 1;
      }
    } catch (err) {
      if (conn.attachments.get(id) === attachment) this.detach(client, id);
      this.logger.error(`replay of ${id} failed: ${(err as Error).message}`);
      throw new SessionError(
        'replay-failed',
        `could not read the session log: ${(err as Error).message}`,
      );
    }
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
      // A replaying attachment picks the record up from disk.
      if (!attachment || attachment.state !== 'live') continue;
      this.send(client, { type: 'session.output', id, ...record });
    }
  }

  /** Replay is pull-based, so instead of dropping we wait for the socket to drain. */
  private async waitForDrain(
    client: WebSocket,
    alive: () => boolean,
  ): Promise<void> {
    const limit = this.config.slowConsumerBytes / 4;
    while (client.bufferedAmount > limit && alive()) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  // ---- helpers ------------------------------------------------------------

  /**
   * Runs a request handler and sends its reply with the request's ref, or
   * an `error` frame. Every failure path ends in a frame the client can
   * correlate; nothing propagates to Nest.
   */
  private handle<K extends keyof ClientFrames>(
    client: WebSocket,
    f: Frame<K>,
    fn: () => DaemonFrame | Promise<DaemonFrame>,
  ): void {
    const ref = f?.ref;
    const id = (f as { id?: unknown })?.id;
    const type = (f as { type?: unknown })?.type;
    const needsId =
      typeof type === 'string' &&
      type.startsWith('session.') &&
      type !== 'session.start';
    if (needsId && typeof id !== 'string') {
      this.send(client, {
        type: 'error',
        ref,
        code: 'invalid-request',
        message: '"id" must be a string',
      });
      return;
    }
    const fail = (err: unknown) => {
      if (err instanceof SessionError) {
        this.send(client, {
          type: 'error',
          ref,
          id: typeof id === 'string' ? id : undefined,
          code: err.code,
          message: err.message,
        });
        return;
      }
      this.logger.error(err);
      this.send(client, {
        type: 'error',
        ref,
        code: 'internal',
        message: (err as Error)?.message ?? String(err),
      });
    };
    try {
      const result = fn();
      if (result instanceof Promise) {
        result.then(
          (frame) => this.send(client, { ...frame, ref } as DaemonFrame),
          fail,
        );
      } else {
        this.send(client, { ...result, ref } as DaemonFrame);
      }
    } catch (err) {
      fail(err);
    }
  }

  /**
   * The single path for frames to a client. A client with more than the
   * slow-consumer bound queued is not reading; it is detached from every
   * session and its socket closed, since even control frames cannot reach it.
   */
  private send(client: WebSocket, frame: DaemonFrame): void {
    if (client.readyState !== client.OPEN) return;
    if (client.bufferedAmount > this.config.slowConsumerBytes) {
      this.logger.warn(
        `dropping slow consumer (${client.bufferedAmount} bytes queued)`,
      );
      this.detachAll(client);
      client.send(
        JSON.stringify({
          type: 'error',
          code: 'slow-consumer',
          message: 'client is not reading fast enough; connection closed',
        } satisfies DaemonFrame),
      );
      client.close(1008, 'slow consumer');
      return;
    }
    client.send(JSON.stringify(frame));
  }

  private broadcast(frame: DaemonFrame): void {
    for (const client of this.connections.keys()) this.send(client, frame);
  }
}
