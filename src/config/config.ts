import os from 'node:os';
import path from 'node:path';

export interface DaemonConfig {
  /** Interface to bind the websocket / http server to. */
  host: string;
  /** TCP port. 0 lets the OS pick (used by tests). */
  port: number;
  /** Directory holding `profiles/*.json`. */
  configDir: string;
  /** Directory holding `sessions/<id>/`. */
  stateDir: string;
  /** Upper bound for a single stdout/stderr line, in bytes. */
  maxLineBytes: number;
  /** Bytes queued for a client (or unwritten to a child's stdin) after which it is considered too slow. */
  slowConsumerBytes: number;
  /** After a child exits, how long inherited pipes may stay open before they are closed. */
  pipeGraceMs: number;
}

export const DAEMON_CONFIG = Symbol('DAEMON_CONFIG');

export const PROTOCOL_VERSION = 1;

/**
 * Where config and state live by default: the XDG dirs on Linux and macOS,
 * and on Windows the profile's Roaming (config) and Local (state) AppData,
 * which is where a per-user service keeps its files there.
 */
export function defaultDir(
  env: NodeJS.ProcessEnv,
  kind: 'config' | 'state',
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const base =
      kind === 'config'
        ? env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
        : env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'agent-daemon');
  }
  const xdg = kind === 'config' ? env.XDG_CONFIG_HOME : env.XDG_STATE_HOME;
  const fallback = kind === 'config' ? '.config' : '.local/state';
  return path.join(
    xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), fallback),
    'agent-daemon',
  );
}

function positiveInt(
  name: string,
  raw: string | undefined,
  fallback: number,
): number {
  const n = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new Error(`${name} must be a positive integer`);
  return n;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): DaemonConfig {
  const listen = env.AGENT_DAEMON_LISTEN ?? '127.0.0.1:4267';
  const idx = listen.lastIndexOf(':');
  const host = idx >= 0 ? listen.slice(0, idx) : '127.0.0.1';
  const port = Number(idx >= 0 ? listen.slice(idx + 1) : listen);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`AGENT_DAEMON_LISTEN has an invalid port: ${listen}`);
  }
  return {
    host: host || '127.0.0.1',
    port,
    configDir:
      env.AGENT_DAEMON_CONFIG_DIR ?? defaultDir(env, 'config', platform),
    stateDir: env.AGENT_DAEMON_STATE_DIR ?? defaultDir(env, 'state', platform),
    maxLineBytes: positiveInt(
      'AGENT_DAEMON_MAX_LINE',
      env.AGENT_DAEMON_MAX_LINE,
      10 * 1024 * 1024,
    ),
    slowConsumerBytes: positiveInt(
      'AGENT_DAEMON_SLOW_CONSUMER_BYTES',
      env.AGENT_DAEMON_SLOW_CONSUMER_BYTES,
      64 * 1024 * 1024,
    ),
    pipeGraceMs: positiveInt(
      'AGENT_DAEMON_PIPE_GRACE_MS',
      env.AGENT_DAEMON_PIPE_GRACE_MS,
      10_000,
    ),
  };
}
