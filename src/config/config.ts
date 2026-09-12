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

function xdg(envName: string, fallback: string): string {
  const v = process.env[envName];
  return v && v.length > 0 ? v : path.join(os.homedir(), fallback);
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
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
      env.AGENT_DAEMON_CONFIG_DIR ??
      path.join(xdg('XDG_CONFIG_HOME', '.config'), 'agent-daemon'),
    stateDir:
      env.AGENT_DAEMON_STATE_DIR ??
      path.join(xdg('XDG_STATE_HOME', '.local/state'), 'agent-daemon'),
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
