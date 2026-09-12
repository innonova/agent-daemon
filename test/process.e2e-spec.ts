import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, FAKE_AGENT, makeDirs } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = path.join(ROOT, 'dist', 'main.js');
const step = (m: string) => process.env.TEST_VERBOSE && console.log('step:', m);

/** Runs the real entry point as a separate process, the way systemd would. */
async function startProcess(dirs: { configDir: string; stateDir: string }) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_DAEMON_LISTEN: '127.0.0.1:0',
    AGENT_DAEMON_CONFIG_DIR: dirs.configDir,
    AGENT_DAEMON_STATE_DIR: dirs.stateDir,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn(process.execPath, [MAIN], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const port = await new Promise<number>((resolve, reject) => {
    const onData = (d: Buffer) => {
      log += d;
      const m = log.match(/listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) resolve(Number(m[1]));
    };
    proc.stdout!.on('data', onData);
    proc.stderr!.on('data', onData);
    proc.on('exit', (code) =>
      reject(new Error(`daemon exited early (${code}):\n${log}`)),
    );
    setTimeout(() => reject(new Error(`daemon did not start:\n${log}`)), 15000);
  });
  return {
    proc,
    port,
    url: `ws://127.0.0.1:${port}/`,
    httpUrl: `http://127.0.0.1:${port}`,
    getLog: () => log,
  };
}

function exited(
  proc: ChildProcess,
  ms: number,
): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error('daemon did not exit in time')),
      ms,
    );
    proc.once('exit', (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal });
    });
  });
}

describe('daemon process', () => {
  beforeAll(() => {
    if (!fs.existsSync(MAIN))
      throw new Error(`build first: ${MAIN} is missing (npm run build)`);
  });

  it('reloads profiles on SIGHUP without dropping the server or its sessions, and shuts down cleanly on SIGTERM', async () => {
    const dirs = makeDirs('agent-daemon-proc-');
    const profiles = path.join(dirs.configDir, 'profiles');
    fs.mkdirSync(profiles, { recursive: true });
    fs.writeFileSync(
      path.join(profiles, 'fake.json'),
      JSON.stringify({ command: process.execPath, args: [FAKE_AGENT] }),
    );
    const dmn = await startProcess(dirs);
    step('daemon started');
    try {
      const c = await Client.connect(dmn.url);
      const started = await c.request<any>({
        type: 'session.start',
        profile: 'fake',
        attach: true,
      });
      const id: string = started.session.id;
      await c.waitForOutput(id, (o) => o?.type === 'ready');
      step('session ready');

      fs.writeFileSync(
        path.join(profiles, 'added.json'),
        JSON.stringify({ command: 'true' }),
      );
      dmn.proc.kill('SIGHUP');
      const changed = await c.waitFor((f) => f.type === 'profiles.changed');
      expect((changed as any).profiles.map((p: any) => p.name)).toEqual([
        'added',
        'fake',
      ]);
      step('profiles reloaded');

      // still serving, session still alive
      expect((await fetch(`${dmn.httpUrl}/health`)).status).toBe(200);
      await c.request({
        type: 'session.input',
        id,
        data: { cmd: 'echo', data: 'after-hup' },
      });
      await c.waitForOutput(
        id,
        (o) => o?.type === 'echo' && o.data === 'after-hup',
      );
      const c2 = await Client.connect(dmn.url);
      expect(
        (await c2.request<any>({ type: 'sessions.list' })).sessions[0].state,
      ).toBe('running');
      await c2.close();
      step('still serving after SIGHUP');

      // SIGTERM: children are terminated and recorded as exited before the process ends
      const gone = exited(dmn.proc, 15000);
      dmn.proc.kill('SIGTERM');
      const result = await gone;
      step(`daemon exited with ${JSON.stringify(result)}`);
      expect(result.code).toBe(0);
      const meta = JSON.parse(
        fs.readFileSync(
          path.join(dirs.stateDir, 'sessions', id, 'meta.json'),
          'utf8',
        ),
      );
      expect(meta).toMatchObject({
        state: 'exited',
        signal: 'SIGTERM',
        exitReason: null,
      });
      await c.close().catch(() => undefined);
    } finally {
      if (dmn.proc.exitCode === null) dmn.proc.kill('SIGKILL');
      if (process.env.TEST_VERBOSE) console.log(dmn.getLog());
    }
  }, 40000);
});
