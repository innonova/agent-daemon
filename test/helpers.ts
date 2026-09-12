import { INestApplication } from '@nestjs/common';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createApp } from '../src/main.js';
import type { DaemonFrame } from '../src/gateway/protocol.js';

export const FAKE_AGENT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-agent.mjs',
);

export interface Daemon {
  app: INestApplication;
  url: string;
  httpUrl: string;
  configDir: string;
  stateDir: string;
  profilesDir: string;
  writeProfile(name: string, profile: Record<string, unknown>): void;
  stop(): Promise<void>;
}

export function makeDirs(prefix = 'agent-daemon-test-'): {
  configDir: string;
  stateDir: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    configDir: path.join(root, 'config'),
    stateDir: path.join(root, 'state'),
  };
}

export async function startDaemon(
  opts: {
    maxLineBytes?: number;
    dirs?: { configDir: string; stateDir: string };
    profiles?: boolean;
  } = {},
): Promise<Daemon> {
  const dirs = opts.dirs ?? makeDirs();
  const profilesDir = path.join(dirs.configDir, 'profiles');
  fs.mkdirSync(profilesDir, { recursive: true });
  const writeProfile = (name: string, profile: Record<string, unknown>) =>
    fs.writeFileSync(
      path.join(profilesDir, `${name}.json`),
      JSON.stringify(profile),
    );
  if (opts.profiles !== false) {
    writeProfile('fake', {
      command: process.execPath,
      args: [FAKE_AGENT, '--base'],
      env: { FAKE_A: 'from-profile' },
    });
  }
  const app = await createApp(
    {
      host: '127.0.0.1',
      port: 0,
      configDir: dirs.configDir,
      stateDir: dirs.stateDir,
      maxLineBytes: opts.maxLineBytes ?? 4096,
      slowConsumerBytes: 1024 * 1024,
      pipeGraceMs: 300,
    },
    { quiet: !process.env.TEST_VERBOSE },
  );
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  return {
    app,
    url: `ws://127.0.0.1:${address.port}/`,
    httpUrl: `http://127.0.0.1:${address.port}`,
    configDir: dirs.configDir,
    stateDir: dirs.stateDir,
    profilesDir,
    writeProfile,
    stop: () => app.close(),
  };
}

type AnyFrame = DaemonFrame & { ref?: string | number };

export class Client {
  private ws!: WebSocket;
  readonly frames: AnyFrame[] = [];
  private waiters: {
    test: (f: AnyFrame) => boolean;
    resolve: (f: AnyFrame) => void;
  }[] = [];
  private nextRef = 1;

  static async connect(url: string): Promise<Client> {
    const c = new Client();
    c.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      c.ws.once('open', resolve);
      c.ws.once('error', reject);
    });
    c.ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as AnyFrame;
      c.frames.push(frame);
      const idx = c.waiters.findIndex((w) => w.test(frame));
      if (idx >= 0) c.waiters.splice(idx, 1)[0].resolve(frame);
    });
    return c;
  }

  sendRaw(data: string): void {
    this.ws.send(data);
  }

  /** Sends a request and resolves with the reply carrying the same ref. */
  request<T extends AnyFrame = AnyFrame>(
    frame: Record<string, unknown>,
    timeoutMs = 5000,
  ): Promise<T> {
    const ref = `r${this.nextRef++}`;
    const p = this.waitFor((f) => f.ref === ref, timeoutMs) as Promise<T>;
    this.ws.send(JSON.stringify({ ...frame, ref }));
    return p;
  }

  /** Resolves with the first frame (already received or future) matching `test`. */
  waitFor(test: (f: AnyFrame) => boolean, timeoutMs = 5000): Promise<AnyFrame> {
    const existing = this.frames.find(test);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== wrapped);
        reject(
          new Error(
            `timed out waiting for frame; got ${JSON.stringify(this.frames.slice(-5))}`,
          ),
        );
      }, timeoutMs);
      const wrapped = (f: AnyFrame) => {
        clearTimeout(timer);
        resolve(f);
      };
      this.waiters.push({ test, resolve: wrapped });
    });
  }

  /** Waits for an output frame for `id` whose parsed data satisfies `test`. */
  waitForOutput(
    id: string,
    test: (data: any, frame: any) => boolean,
    timeoutMs = 5000,
  ): Promise<any> {
    return this.waitFor((f) => {
      if (f.type !== 'session.output' || f.id !== id) return false;
      let data: unknown;
      try {
        data = JSON.parse(f.d);
      } catch {
        data = undefined;
      }
      return test(data, f);
    }, timeoutMs);
  }

  outputs(id: string): AnyFrame[] {
    return this.frames.filter(
      (f) => f.type === 'session.output' && f.id === id,
    );
  }

  /** Discards previously received frames so waitFor only sees new ones. */
  clear(): void {
    this.frames.length = 0;
  }

  close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      this.ws.once('close', () => resolve());
      if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
      else if (this.ws.readyState === WebSocket.CONNECTING) this.ws.terminate();
    });
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
