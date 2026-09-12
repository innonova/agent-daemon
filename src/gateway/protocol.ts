/**
 * Wire protocol, version 1. Every frame is a JSON object with a `type`.
 * Requests carry a client-chosen `ref`; the direct reply echoes it.
 * See docs/design.md.
 */
import type { PublicProfile } from '../profiles/profile.js';
import type { LogRecord } from '../sessions/session-log.js';
import type { SessionRecord } from '../sessions/session.js';

export type Ref = string | number;

export type ReplayOption = boolean | { fromSeq: number };

export interface ClientFrames {
  hello: { protocol: number };
  'profiles.list': Record<string, never>;
  'profiles.reload': Record<string, never>;
  'sessions.list': Record<string, never>;
  'session.get': { id: string };
  'session.start': {
    profile: string;
    args?: string[];
    argsReplace?: string[];
    cwd?: string;
    env?: Record<string, string>;
    label?: string;
    id?: string;
    attach?: boolean;
    replay?: ReplayOption;
  };
  'session.attach': { id: string; replay?: ReplayOption };
  'session.detach': { id: string };
  'session.input': { id: string; data: unknown };
  'session.signal': { id: string; signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' };
  'session.end-input': { id: string };
  'session.remove': { id: string };
}

export type ClientFrameType = keyof ClientFrames;

export type ClientFrame = {
  [K in ClientFrameType]: { type: K; ref?: Ref } & ClientFrames[K];
}[ClientFrameType];

export const CLIENT_FRAME_TYPES: readonly ClientFrameType[] = [
  'hello',
  'profiles.list',
  'profiles.reload',
  'sessions.list',
  'session.get',
  'session.start',
  'session.attach',
  'session.detach',
  'session.input',
  'session.signal',
  'session.end-input',
  'session.remove',
];

export type DaemonFrame =
  | {
      type: 'welcome';
      ref?: Ref;
      protocol: number;
      version: string;
      profiles: PublicProfile[];
      sessions: SessionRecord[];
    }
  | { type: 'profiles'; ref?: Ref; profiles: PublicProfile[] }
  | { type: 'sessions'; ref?: Ref; sessions: SessionRecord[] }
  | { type: 'session'; ref?: Ref; session: SessionRecord }
  | { type: 'session.started'; ref?: Ref; session: SessionRecord }
  | {
      type: 'session.attached';
      ref?: Ref;
      session: SessionRecord;
      lastSeq: number;
    }
  | { type: 'session.detached'; ref?: Ref; id: string }
  | { type: 'ok'; ref?: Ref }
  | ({ type: 'session.output'; id: string } & LogRecord)
  | {
      type: 'session.exit';
      id: string;
      exitCode: number | null;
      signal: string | null;
      exitReason: string | null;
      exitedAt: number | null;
    }
  | { type: 'session.changed'; session: SessionRecord }
  | { type: 'profiles.changed'; profiles: PublicProfile[] }
  | { type: 'error'; ref?: Ref; id?: string; code: string; message: string };
