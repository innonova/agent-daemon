import fs from 'node:fs';
import path from 'node:path';
import { SessionsService } from '../src/sessions/sessions.service.js';
import {
  Client,
  Daemon,
  FAKE_AGENT,
  makeDirs,
  sleep,
  startDaemon,
} from './helpers.js';

let d: Daemon;
const clients: Client[] = [];

async function connect(): Promise<Client> {
  const c = await Client.connect(d.url);
  clients.push(c);
  return c;
}

/** Starts a fake session attached with the given client and waits for its ready line. */
async function startFake(c: Client, extra: Record<string, unknown> = {}) {
  const started = await c.request<any>({
    type: 'session.start',
    profile: 'fake',
    attach: true,
    ...extra,
  });
  expect(started.type).toBe('session.started');
  expect(started.attached).toBe(true);
  const id: string = started.session.id;
  const ready = await c.waitForOutput(id, (o) => o?.type === 'ready');
  return { id, ready: JSON.parse(ready.d), session: started.session };
}

beforeAll(async () => {
  d = await startDaemon();
});

afterAll(async () => {
  await d.stop();
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe('http', () => {
  it('serves a health check', async () => {
    const res = await fetch(`${d.httpUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('handshake and framing', () => {
  it('answers hello with the protocol version, profiles and sessions', async () => {
    const c = await connect();
    const w = await c.request<any>({ type: 'hello', protocol: 1 });
    expect(w.type).toBe('welcome');
    expect(w.protocol).toBe(1);
    expect(typeof w.version).toBe('string');
    expect(w.profiles.map((p: any) => p.name)).toContain('fake');
    expect(w.profiles[0]).not.toHaveProperty('file');
    expect(Array.isArray(w.sessions)).toBe(true);
  });

  it('rejects an unsupported protocol version', async () => {
    const c = await connect();
    const e = await c.request<any>({ type: 'hello', protocol: 99 });
    expect(e).toMatchObject({ type: 'error', code: 'unsupported-protocol' });
  });

  it('reports unknown frame types and malformed frames', async () => {
    const c = await connect();
    const e1 = await c.request<any>({ type: 'nonsense' });
    expect(e1).toMatchObject({ type: 'error', code: 'unknown-type' });
    c.sendRaw('this is not json');
    const e2 = await c.waitFor(
      (f) => f.type === 'error' && (f as any).code === 'malformed',
    );
    expect(e2).toBeTruthy();
    c.sendRaw(JSON.stringify({ ref: 'x', noType: true }));
    const e3 = await c.waitFor((f) => f.type === 'error' && f.ref === 'x');
    expect(e3).toMatchObject({ code: 'malformed' });
  });
});

describe('starting sessions', () => {
  it('appends request args to profile args and merges env and cwd', async () => {
    const c = await connect();
    const cwd = fs.mkdtempSync(path.join(d.stateDir, 'cwd-'));
    const { ready, session } = await startFake(c, {
      args: ['--extra'],
      env: { FAKE_B: 'from-request' },
      cwd,
      label: 'lbl',
    });
    expect(ready.argv).toEqual(['--base', '--extra']);
    expect(ready.env).toEqual({
      FAKE_A: 'from-profile',
      FAKE_B: 'from-request',
      FAKE_LOGIN: null,
    });
    expect(fs.realpathSync(ready.cwd)).toBe(fs.realpathSync(cwd));
    expect(session).toMatchObject({
      profile: 'fake',
      label: 'lbl',
      state: 'running',
      args: [FAKE_AGENT, '--base', '--extra'],
    });
    expect(session.env).toEqual({
      FAKE_A: 'from-profile',
      FAKE_B: 'from-request',
    });
    expect(typeof session.pid).toBe('number');
  });

  it('lets the request override env from the profile', async () => {
    const c = await connect();
    const { ready } = await startFake(c, { env: { FAKE_A: 'overridden' } });
    expect(ready.env.FAKE_A).toBe('overridden');
  });

  it('argsReplace drops the profile args entirely', async () => {
    const c = await connect();
    const { ready } = await startFake(c, {
      argsReplace: [FAKE_AGENT, '--only'],
    });
    expect(ready.argv).toEqual(['--only']);
  });

  it('accepts a client-chosen id and rejects duplicates and bad ids', async () => {
    const c = await connect();
    const id = `chosen-${Date.now()}`;
    const { session } = await startFake(c, { id });
    expect(session.id).toBe(id);
    const dup = await c.request<any>({
      type: 'session.start',
      profile: 'fake',
      id,
    });
    expect(dup).toMatchObject({ type: 'error', code: 'duplicate-id' });
    const bad = await c.request<any>({
      type: 'session.start',
      profile: 'fake',
      id: '../escape',
    });
    expect(bad).toMatchObject({ type: 'error', code: 'invalid-id' });
  });

  it('rejects wrongly typed request fields without creating anything', async () => {
    const c = await connect();
    const before = fs.readdirSync(path.join(d.stateDir, 'sessions')).length;
    for (const bad of [
      { profile: 5 },
      { attach: 'false' },
      { replay: null },
      { args: 'no' },
      { args: [1] },
      { argsReplace: 'no' },
      { env: ['x'] },
      { env: { A: 1 } },
      { cwd: 5 },
      { label: {} },
      { id: 7 },
    ]) {
      const e = await c.request<any>({
        type: 'session.start',
        profile: 'fake',
        ...bad,
      });
      expect(e).toMatchObject({ type: 'error', code: 'invalid-request' });
    }
    expect(fs.readdirSync(path.join(d.stateDir, 'sessions')).length).toBe(
      before,
    );
    for (const bad of [
      { type: 'session.get', id: 123 },
      { type: 'session.detach', id: {} },
      { type: 'session.input', id: null, data: 'x' },
      { type: 'session.attach' },
      { type: 'session.remove', id: ['x'] },
    ]) {
      expect(await c.request<any>(bad)).toMatchObject({
        type: 'error',
        code: 'invalid-request',
      });
    }
    const { id } = await startFake(c);
    expect(
      await c.request({ type: 'session.attach', id, replay: { fromSeq: 'x' } }),
    ).toMatchObject({ type: 'error', code: 'invalid-request' });
  });

  it('rejects an unknown profile', async () => {
    const c = await connect();
    const e = await c.request<any>({ type: 'session.start', profile: 'nope' });
    expect(e).toMatchObject({ type: 'error', code: 'unknown-profile' });
  });

  it('records a spawn failure as an exited session with stderr output', async () => {
    d.writeProfile('missing', { command: '/definitely/not/here' });
    await (await connect()).request({ type: 'profiles.reload' });
    const c = await connect();
    const started = await c.request<any>({
      type: 'session.start',
      profile: 'missing',
      attach: true,
    });
    expect(started.type).toBe('session.started');
    const exit = await c.waitFor(
      (f) => f.type === 'session.exit' && (f as any).id === started.session.id,
    );
    expect((exit as any).exitReason).toMatch(/^spawn-error: /);
    const errLine = c
      .outputs(started.session.id)
      .find((f: any) => f.s === 'err');
    expect((errLine as any).d).toMatch(/ENOENT/);
  });

  it('spawns through a login shell when the profile asks for it', async () => {
    d.writeProfile('login', {
      command: process.execPath,
      args: [FAKE_AGENT],
      loginShell: true,
      env: { FAKE_LOGIN: 'yes' },
    });
    await (await connect()).request({ type: 'profiles.reload' });
    const c = await connect();
    const started = await c.request<any>({
      type: 'session.start',
      profile: 'login',
      attach: true,
      args: ["it's quoted"],
    });
    const ready = JSON.parse(
      (await c.waitForOutput(started.session.id, (o) => o?.type === 'ready')).d,
    );
    expect(ready.argv).toEqual(["it's quoted"]);
    expect(ready.env.FAKE_LOGIN).toBe('yes');
  });

  it('turns a synchronous spawn failure into an exited session', async () => {
    const c = await connect();
    const started = await c.request<any>({
      type: 'session.start',
      profile: 'fake',
      attach: true,
      cwd: '/etc/hostname',
    });
    expect(started.type).toBe('session.started');
    const exit = await c.waitFor(
      (f) => f.type === 'session.exit' && (f as any).id === started.session.id,
    );
    expect((exit as any).exitReason).toMatch(/^spawn-error: .*ENOTDIR/);
    expect(c.outputs(started.session.id).map((f: any) => f.s)).toEqual(['err']);
    const meta = JSON.parse(
      fs.readFileSync(
        path.join(d.stateDir, 'sessions', started.session.id, 'meta.json'),
        'utf8',
      ),
    );
    expect(meta.state).toBe('exited');
  });

  it('login shell runs the profile and execs the agent so the session pid is the agent pid', async () => {
    // A shell that sets something only a login profile would, and does not
    // tail-exec: only an explicit exec makes the pids match.
    const shell = path.join(d.stateDir, 'fake-shell.sh');
    fs.writeFileSync(
      shell,
      '#!/bin/sh\nFAKE_LOGIN=from-shell; export FAKE_LOGIN\neval "$2"\necho should-not-print\n',
      { mode: 0o755 },
    );
    const prev = process.env.SHELL;
    process.env.SHELL = shell;
    try {
      d.writeProfile('login2', {
        command: process.execPath,
        args: [FAKE_AGENT],
        loginShell: true,
      });
      await (await connect()).request({ type: 'profiles.reload' });
      const c = await connect();
      const started = await c.request<any>({
        type: 'session.start',
        profile: 'login2',
        attach: true,
      });
      const ready = JSON.parse(
        (await c.waitForOutput(started.session.id, (o) => o?.type === 'ready'))
          .d,
      );
      expect(ready.pid).toBe(started.session.pid);
      expect(ready.env.FAKE_LOGIN).toBe('from-shell');
      await c.request({
        type: 'session.signal',
        id: started.session.id,
        signal: 'SIGTERM',
      });
      const exit = await c.waitFor(
        (f) =>
          f.type === 'session.exit' && (f as any).id === started.session.id,
      );
      expect(exit).toMatchObject({ signal: 'SIGTERM' });
    } finally {
      process.env.SHELL = prev;
    }
  });

  it('broadcasts session.changed to every connection on start and exit', async () => {
    const watcher = await connect();
    const c = await connect();
    const { id } = await startFake(c);
    const changed = await watcher.waitFor(
      (f) => f.type === 'session.changed' && (f as any).session.id === id,
    );
    expect((changed as any).session.state).toBe('running');
    await c.request({
      type: 'session.input',
      id,
      data: { cmd: 'exit', code: 3 },
    });
    const exit = await watcher.waitFor(
      (f) => f.type === 'session.exit' && (f as any).id === id,
    );
    expect(exit).toMatchObject({ exitCode: 3, signal: null });
    const exited = await watcher.waitFor(
      (f) =>
        f.type === 'session.changed' &&
        (f as any).session.id === id &&
        (f as any).session.state === 'exited',
    );
    expect((exited as any).session).toMatchObject({ exitCode: 3, lastSeq: 2 });
  });
});

describe('input and output', () => {
  it('forwards input, records it, and streams output with contiguous seq', async () => {
    const c = await connect();
    const { id } = await startFake(c);
    const ok = await c.request<any>({
      type: 'session.input',
      id,
      data: { cmd: 'echo', data: 42 },
    });
    expect(ok.type).toBe('ok');
    await c.waitForOutput(id, (o) => o?.type === 'echo' && o.data === 42);
    const ok2 = await c.request<any>({
      type: 'session.input',
      id,
      data: '{"cmd":"echo","data":"str"}',
    });
    expect(ok2.type).toBe('ok');
    await c.waitForOutput(id, (o) => o?.type === 'echo' && o.data === 'str');
    const frames = c.outputs(id) as any[];
    expect(frames.map((f) => f.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(frames.map((f) => f.s)).toEqual(['out', 'in', 'out', 'in', 'out']);
    expect(frames[1].d).toBe('{"cmd":"echo","data":42}');
    expect(frames[3].d).toBe('{"cmd":"echo","data":"str"}');
    expect(frames.every((f) => typeof f.t === 'number')).toBe(true);
  });

  it('captures stderr as err records', async () => {
    const c = await connect();
    const { id } = await startFake(c);
    await c.request({
      type: 'session.input',
      id,
      data: { cmd: 'stderr', text: 'warning: something' },
    });
    const f = await c.waitFor(
      (f) =>
        f.type === 'session.output' &&
        (f as any).s === 'err' &&
        (f as any).id === id,
    );
    expect((f as any).d).toBe('warning: something');
  });

  it('drops oversized lines with a note and keeps going', async () => {
    const c = await connect();
    const { id } = await startFake(c);
    await c.request({
      type: 'session.input',
      id,
      data: { cmd: 'big', bytes: 4096 },
    });
    await c.waitForOutput(id, (_o, f) => f.s === 'out' && f.d.length === 4096);
    await c.request({
      type: 'session.input',
      id,
      data: { cmd: 'big', bytes: 100_000 },
    });
    await c.waitFor(
      (f) =>
        f.type === 'session.output' &&
        (f as any).s === 'err' &&
        (f as any).d.startsWith('agent-daemon: dropped'),
    );
    const notes = c
      .outputs(id)
      .filter((f: any) => f.s === 'err')
      .map((f: any) => f.d);
    expect(notes).toEqual([
      'agent-daemon: line on stdout exceeds 4096 bytes; dropping it',
      'agent-daemon: dropped 100000 bytes exceeding line limit on stdout',
    ]);
    await c.request({
      type: 'session.input',
      id,
      data: { cmd: 'echo', data: 'after' },
    });
    await c.waitForOutput(id, (o) => o?.type === 'echo' && o.data === 'after');
  });

  it('emits a trailing partial line when the child exits', async () => {
    const c = await connect();
    const { id } = await startFake(c);
    await c.request({
      type: 'session.input',
      id,
      data: { cmd: 'partial', text: 'no newline' },
    });
    await sleep(50);
    await c.request({
      type: 'session.input',
      id,
      data: { cmd: 'exit', code: 0 },
    });
    await c.waitFor((f) => f.type === 'session.exit' && (f as any).id === id);
    expect(
      c.outputs(id).some((f: any) => f.s === 'out' && f.d === 'no newline'),
    ).toBe(true);
  });

  it('delivers output to every attached client and stops after detach', async () => {
    const a = await connect();
    const b = await connect();
    const { id } = await startFake(a);
    const attached = await b.request<any>({ type: 'session.attach', id });
    expect(attached.type).toBe('session.attached');
    await a.request({
      type: 'session.input',
      id,
      data: { cmd: 'echo', data: 'both' },
    });
    await a.waitForOutput(id, (o) => o?.type === 'echo' && o.data === 'both');
    await b.waitForOutput(id, (o) => o?.type === 'echo' && o.data === 'both');
    expect(b.outputs(id).some((f: any) => f.d.includes('"ready"'))).toBe(false); // attached without replay

    const det = await b.request<any>({ type: 'session.detach', id });
    expect(det).toMatchObject({ type: 'session.detached', id });
    b.clear();
    await a.request({
      type: 'session.input',
      id,
      data: { cmd: 'echo', data: 'only-a' },
    });
    await a.waitForOutput(id, (o) => o?.type === 'echo' && o.data === 'only-a');
    await sleep(50);
    expect(b.outputs(id)).toEqual([]);
  });

  it('accepts input from a connection that is not attached', async () => {
    const a = await connect();
    const b = await connect();
    const { id } = await startFake(a);
    const ok = await b.request<any>({
      type: 'session.input',
      id,
      data: { cmd: 'echo', data: 'from-b' },
    });
    expect(ok.type).toBe('ok');
    await a.waitForOutput(id, (o) => o?.type === 'echo' && o.data === 'from-b');
  });

  it('refuses input once the process stops reading stdin', async () => {
    const c = await connect();
    const { id } = await startFake(c);
    await c.request({
      type: 'session.input',
      id,
      data: { cmd: 'pause-stdin' },
    });
    await c.waitForOutput(id, (o) => o?.type === 'paused');
    // ok is only sent once bytes reach the pipe, so a client that awaits each
    // reply is flow-controlled. One that does not gets refused past the limit.
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 40; i++)
      c.sendRaw(
        JSON.stringify({
          type: 'session.input',
          ref: `bulk${i}`,
          id,
          data: chunk,
        }),
      );
    const err = await c.waitFor(
      (f) => f.type === 'error' && (f as any).code === 'stdin-full',
    );
    expect(err).toBeTruthy();
    await c.request({ type: 'session.signal', id, signal: 'SIGKILL' });
    await c.waitFor((f) => f.type === 'session.exit' && (f as any).id === id);
  });

  it('acknowledges input only once it reaches the pipe', async () => {
    const c = await connect();
    const { id } = await startFake(c);
    await c.request({
      type: 'session.input',
      id,
      data: { cmd: 'pause-stdin', ms: 1500 },
    });
    await c.waitForOutput(id, (o) => o?.type === 'paused');
    // fill the pipe well past the kernel buffer while the agent is not reading
    const chunk = 'y'.repeat(64 * 1024);
    const t0 = Date.now();
    const pending: Promise<any>[] = [];
    for (let i = 0; i < 6; i++)
      pending.push(
        c.request({ type: 'session.input', id, data: chunk }, 20000),
      );
    const replies = await Promise.all(pending);
    expect(replies.every((r) => r.type === 'ok')).toBe(true);
    // the last one could only complete after the agent resumed reading
    expect(Date.now() - t0).toBeGreaterThan(1000);
  });

  it('reports a failed stdin write instead of ok', async () => {
    const c = await connect();
    const { id } = await startFake(c);
    await c.request({
      type: 'session.input',
      id,
      data: { cmd: 'close-stdin' },
    });
    await c.waitForOutput(id, (o) => o?.type === 'stdin-destroyed');
    let reply: any;
    for (let i = 0; i < 20; i++) {
      reply = await c.request({
        type: 'session.input',
        id,
        data: 'x'.repeat(1024),
      });
      if (reply.type === 'error') break;
      await sleep(20);
    }
    // the daemon cannot learn of the closed read end except by writing to
    // it, so the first failure is always the write itself
    expect(reply).toMatchObject({ type: 'error', code: 'stdin-error' });
    expect(
      c
        .outputs(id)
        .some(
          (f: any) =>
            f.s === 'err' && f.d.startsWith('agent-daemon: stdin write failed'),
        ),
    ).toBe(true);
    expect(
      await c.request({ type: 'session.input', id, data: 'x' }),
    ).toMatchObject({ type: 'error', code: 'stdin-closed' });
    await c.request({ type: 'session.signal', id, signal: 'SIGKILL' });
  });

  it('requires data on input and rejects unknown sessions', async () => {
    const c = await connect();
    const { id } = await startFake(c);
    expect(await c.request({ type: 'session.input', id })).toMatchObject({
      type: 'error',
      code: 'invalid-input',
    });
    expect(
      await c.request({ type: 'session.input', id: 'nope', data: 'x' }),
    ).toMatchObject({ type: 'error', code: 'unknown-session', id: 'nope' });
    expect(
      await c.request({ type: 'session.attach', id: 'nope' }),
    ).toMatchObject({ type: 'error', code: 'unknown-session' });
    expect(await c.request({ type: 'session.get', id: 'nope' })).toMatchObject({
      type: 'error',
      code: 'unknown-session',
    });
  });
});

describe('replay', () => {
  it('replays the whole log, then continues live, with contiguous seq', async () => {
    const a = await connect();
    const { id } = await startFake(a);
    await a.request({
      type: 'session.input',
      id,
      data: { cmd: 'echo', data: 1 },
    });
    await a.waitForOutput(id, (o) => o?.type === 'echo' && o.data === 1);

    const b = await connect();
    const attached = await b.request<any>({
      type: 'session.attach',
      id,
      replay: true,
    });
    expect(attached).toMatchObject({ type: 'session.attached', lastSeq: 3 });
    const replayed = b.outputs(id) as any[];
    expect(replayed.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(replayed.map((f) => f.s)).toEqual(['out', 'in', 'out']);

    await a.request({
      type: 'session.input',
      id,
      data: { cmd: 'echo', data: 2 },
    });
    await b.waitForOutput(id, (o) => o?.type === 'echo' && o.data === 2);
    expect((b.outputs(id) as any[]).map((f) => f.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('replays from a given seq', async () => {
    const a = await connect();
    const { id } = await startFake(a);
    await a.request({
      type: 'session.input',
      id,
      data: { cmd: 'echo', data: 1 },
    });
    await a.waitForOutput(id, (o) => o?.type === 'echo' && o.data === 1);
    const b = await connect();
    const attached = await b.request<any>({
      type: 'session.attach',
      id,
      replay: { fromSeq: 3 },
    });
    expect(attached.lastSeq).toBe(3);
    expect((b.outputs(id) as any[]).map((f) => f.seq)).toEqual([3]);
  });

  it('replay on start delivers the ready line', async () => {
    const c = await connect();
    const started = await c.request<any>({
      type: 'session.start',
      profile: 'fake',
      attach: true,
      replay: true,
    });
    await c.waitForOutput(started.session.id, (o) => o?.type === 'ready');
    expect((c.outputs(started.session.id) as any[]).map((f) => f.seq)).toEqual([
      1,
    ]);
  });

  it('never duplicates or skips records when attaching during heavy output', async () => {
    const a = await connect();
    const { id } = await startFake(a);
    await a.request({
      type: 'session.input',
      id,
      data: { cmd: 'spam', n: 2000 },
    });
    const b = await connect();
    const attachP = b.request<any>({
      type: 'session.attach',
      id,
      replay: true,
    });
    await a.request({
      type: 'session.input',
      id,
      data: { cmd: 'spam', n: 2000 },
    });
    await attachP;
    await a.request({
      type: 'session.input',
      id,
      data: { cmd: 'echo', data: 'done' },
    });
    await b.waitForOutput(
      id,
      (o) => o?.type === 'echo' && o.data === 'done',
      10000,
    );
    const seqs = (b.outputs(id) as any[]).map((f) => f.seq);
    expect(seqs.length).toBe(1 + 1 + 2000 + 1 + 2000 + 1 + 1);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it('closes a client that stops reading live output', async () => {
    const a = await connect();
    const { id } = await startFake(a);
    // a only drives the session; it must not receive the burst itself
    await a.request({ type: 'session.detach', id });
    const b = await connect();
    await b.request({ type: 'session.attach', id });
    const sock = (b as any).ws._socket as { pause(): void; resume(): void };
    sock.pause();
    // one burst far past the 1 MB test threshold, allowing for what loopback
    // kernel buffers absorb before the daemon's own queue grows
    await a.request({
      type: 'session.input',
      id,
      data: { cmd: 'spam', n: 300_000 },
    });
    for (;;) {
      const got = await a.request<any>({ type: 'session.get', id });
      if (got.session.lastSeq >= 300_000) break;
      await sleep(100);
    }
    sock.resume();
    const err = await b.waitFor(
      (f) => f.type === 'error' && (f as any).code === 'slow-consumer',
      15000,
    );
    expect(err).toBeTruthy();
    await new Promise<void>((resolve) => (b as any).ws.once('close', resolve));
    clients.splice(clients.indexOf(b), 1);
    // the session and other clients are unaffected
    await a.request({ type: 'session.attach', id });
    await a.request({
      type: 'session.input',
      id,
      data: { cmd: 'echo', data: 'after' },
    });
    await a.waitForOutput(id, (o) => o?.type === 'echo' && o.data === 'after');
  }, 40000);

  it('reports the session boundary for a cursor in the future', async () => {
    const a = await connect();
    const { id } = await startFake(a);
    const b = await connect();
    const attached = await b.request<any>({
      type: 'session.attach',
      id,
      replay: { fromSeq: 100 },
    });
    expect(attached.lastSeq).toBe(1);
    expect(b.outputs(id)).toEqual([]);
    await a.request({
      type: 'session.input',
      id,
      data: { cmd: 'echo', data: 'x' },
    });
    const next = await b.waitFor(
      (f) => f.type === 'session.output' && (f as any).id === id,
    );
    expect((next as any).seq).toBe(2);
  });

  it('cancels a replay when the client detaches midway', async () => {
    const a = await connect();
    const { id } = await startFake(a);
    await a.request({
      type: 'session.input',
      id,
      data: { cmd: 'spam', n: 30000 },
    });
    await a.waitForOutput(
      id,
      (o) => o?.type === 'spam' && o.i === 29999,
      20000,
    );
    const b = await connect();
    const attachP = b.request<any>(
      { type: 'session.attach', id, replay: true },
      30000,
    );
    await b.waitFor(
      (f) => f.type === 'session.output' && (f as any).id === id,
      10000,
    );
    const detached = await b.request<any>({ type: 'session.detach', id });
    expect(detached.type).toBe('session.detached');
    const reply = await attachP;
    expect(reply).toMatchObject({ type: 'error', code: 'cancelled' });
    const afterDetach = b.frames.indexOf(detached);
    expect(
      b.frames
        .slice(afterDetach + 1)
        .filter((f) => f.type === 'session.output'),
    ).toEqual([]);
    expect((await b.request<any>({ type: 'sessions.list' })).type).toBe(
      'sessions',
    );
  }, 30000);

  it('an invalid replay option leaves an existing attachment alone', async () => {
    const a = await connect();
    const { id } = await startFake(a);
    const b = await connect();
    await b.request({ type: 'session.attach', id });
    expect(
      await b.request({ type: 'session.attach', id, replay: { fromSeq: 'x' } }),
    ).toMatchObject({ type: 'error', code: 'invalid-request' });
    expect(
      await b.request({ type: 'session.attach', id, replay: 'yes' }),
    ).toMatchObject({ type: 'error', code: 'invalid-request' });
    await a.request({
      type: 'session.input',
      id,
      data: { cmd: 'echo', data: 'still' },
    });
    await b.waitForOutput(id, (o) => o?.type === 'echo' && o.data === 'still');
  });

  it('fails replay, and stays detached, when the log is gone', async () => {
    const a = await connect();
    const { id } = await startFake(a);
    fs.rmSync(path.join(d.stateDir, 'sessions', id, 'log.ndjson'));
    const b = await connect();
    expect(
      await b.request({ type: 'session.attach', id, replay: true }),
    ).toMatchObject({ type: 'error', code: 'replay-failed' });
    // also when nothing would need reading: a cursor past the boundary
    expect(
      await b.request({ type: 'session.attach', id, replay: { fromSeq: 999 } }),
    ).toMatchObject({ type: 'error', code: 'replay-failed' });
    await a.request({
      type: 'session.input',
      id,
      data: { cmd: 'echo', data: 'x' },
    });
    await a.waitForOutput(id, (o) => o?.type === 'echo');
    await sleep(50);
    expect(b.outputs(id)).toEqual([]);
  });

  it('replays an exited session from disk', async () => {
    const a = await connect();
    const { id } = await startFake(a);
    await a.request({
      type: 'session.input',
      id,
      data: { cmd: 'exit', code: 0 },
    });
    await a.waitFor((f) => f.type === 'session.exit' && (f as any).id === id);
    const b = await connect();
    const attached = await b.request<any>({
      type: 'session.attach',
      id,
      replay: true,
    });
    expect(attached.session.state).toBe('exited');
    expect((b.outputs(id) as any[]).map((f) => f.s)).toEqual(['out', 'in']);
  });
});

describe('lifecycle', () => {
  it('reports exit codes, rejects input afterwards, and keeps the record', async () => {
    const c = await connect();
    const { id } = await startFake(c);
    await c.request({
      type: 'session.input',
      id,
      data: { cmd: 'exit', code: 7 },
    });
    const exit = await c.waitFor(
      (f) => f.type === 'session.exit' && (f as any).id === id,
    );
    expect(exit).toMatchObject({ exitCode: 7, signal: null, exitReason: null });
    const got = await c.request<any>({ type: 'session.get', id });
    expect(got.session).toMatchObject({
      state: 'exited',
      exitCode: 7,
      pid: expect.any(Number),
    });
    expect(typeof got.session.exitedAt).toBe('number');
    const e = await c.request({ type: 'session.input', id, data: 'x' });
    expect(e).toMatchObject({ type: 'error', code: 'session-not-running' });
    const meta = JSON.parse(
      fs.readFileSync(
        path.join(d.stateDir, 'sessions', id, 'meta.json'),
        'utf8',
      ),
    );
    expect(meta).toMatchObject({ id, state: 'exited', exitCode: 7 });
  });

  it('delivers signals', async () => {
    const c = await connect();
    const { id } = await startFake(c);
    await c.request({ type: 'session.input', id, data: { cmd: 'trap-int' } });
    await c.waitForOutput(id, (o) => o?.type === 'trapped');
    expect(
      await c.request({ type: 'session.signal', id, signal: 'SIGINT' }),
    ).toMatchObject({ type: 'ok' });
    await c.waitForOutput(id, (o) => o?.type === 'sigint');
    const exit = await c.waitFor(
      (f) => f.type === 'session.exit' && (f as any).id === id,
    );
    expect(exit).toMatchObject({ exitCode: 130 });

    const { id: id2 } = await startFake(c);
    await c.request({ type: 'session.signal', id: id2, signal: 'SIGKILL' });
    const exit2 = await c.waitFor(
      (f) => f.type === 'session.exit' && (f as any).id === id2,
    );
    expect(exit2).toMatchObject({ exitCode: null, signal: 'SIGKILL' });

    expect(
      await c.request({ type: 'session.signal', id: id2, signal: 'SIGUSR1' }),
    ).toMatchObject({ type: 'error', code: 'invalid-signal' });
  });

  it('closes stdin on end-input', async () => {
    const c = await connect();
    const { id } = await startFake(c);
    expect(await c.request({ type: 'session.end-input', id })).toMatchObject({
      type: 'ok',
    });
    await c.waitForOutput(id, (o) => o?.type === 'stdin-closed');
    await c.waitFor((f) => f.type === 'session.exit' && (f as any).id === id);
  });

  it('closes pipes a descendant kept open after the child exited', async () => {
    const c = await connect();
    const { id } = await startFake(c);
    await c.request({
      type: 'session.input',
      id,
      data: { cmd: 'orphan', partial: 'kept' },
    });
    const orphaned = JSON.parse(
      (await c.waitForOutput(id, (o) => o?.type === 'orphaned')).d,
    );
    try {
      const exit = await c.waitFor(
        (f) => f.type === 'session.exit' && (f as any).id === id,
        5000,
      );
      expect(exit).toMatchObject({ exitCode: 0 });
      expect(
        c.outputs(id).some((f: any) => f.s === 'out' && f.d === 'kept'),
      ).toBe(true);
    } finally {
      try {
        process.kill(orphaned.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  });

  it('removes only exited sessions and deletes their directory', async () => {
    const c = await connect();
    const { id } = await startFake(c);
    expect(await c.request({ type: 'session.remove', id })).toMatchObject({
      type: 'error',
      code: 'session-running',
    });
    await c.request({ type: 'session.input', id, data: { cmd: 'exit' } });
    await c.waitFor((f) => f.type === 'session.exit' && (f as any).id === id);
    const dir = path.join(d.stateDir, 'sessions', id);
    expect(fs.existsSync(dir)).toBe(true);
    const watcher = await connect();
    expect(await c.request({ type: 'session.remove', id })).toMatchObject({
      type: 'ok',
    });
    expect(fs.existsSync(dir)).toBe(false);
    expect(
      await watcher.waitFor((f) => f.type === 'session.removed'),
    ).toMatchObject({ id });
    const list = await c.request<any>({ type: 'sessions.list' });
    expect(list.sessions.map((s: any) => s.id)).not.toContain(id);
    expect(await c.request({ type: 'session.get', id })).toMatchObject({
      type: 'error',
      code: 'unknown-session',
    });
  });

  it('lists sessions oldest first', async () => {
    const c = await connect();
    const { id: first } = await startFake(c);
    await sleep(5);
    const { id: second } = await startFake(c);
    const list = await c.request<any>({ type: 'sessions.list' });
    const ids = list.sessions.map((s: any) => s.id);
    expect(ids.indexOf(first)).toBeLessThan(ids.indexOf(second));
  });

  it('detaches everything when the connection closes without touching the session', async () => {
    const a = await connect();
    const { id } = await startFake(a);
    await a.close();
    clients.splice(clients.indexOf(a), 1);
    const b = await connect();
    const got = await b.request<any>({ type: 'session.get', id });
    expect(got.session.state).toBe('running');
    await b.request({ type: 'session.input', id, data: { cmd: 'exit' } });
  });
});

describe('profiles', () => {
  it('reloads on request, broadcasts the change, and leaves running sessions alone', async () => {
    const watcher = await connect();
    const c = await connect();
    const { id } = await startFake(c);
    d.writeProfile('fake', {
      command: process.execPath,
      args: [FAKE_AGENT, '--changed'],
    });
    d.writeProfile('broken', '{not json' as unknown as Record<string, unknown>);
    fs.writeFileSync(path.join(d.profilesDir, 'broken.json'), '{not json');
    const reply = await c.request<any>({ type: 'profiles.reload' });
    expect(reply.type).toBe('profiles');
    expect(reply.profiles.map((p: any) => p.name)).not.toContain('broken');
    expect(reply.profiles.find((p: any) => p.name === 'fake').args).toEqual([
      FAKE_AGENT,
      '--changed',
    ]);
    const changed = await watcher.waitFor((f) => f.type === 'profiles.changed');
    expect(
      (changed as any).profiles.find((p: any) => p.name === 'fake').args,
    ).toEqual([FAKE_AGENT, '--changed']);
    const list = await c.request<any>({ type: 'profiles.list' });
    expect(list.profiles.find((p: any) => p.name === 'fake').args).toEqual([
      FAKE_AGENT,
      '--changed',
    ]);

    // the running session still answers and keeps its original args
    await c.request({
      type: 'session.input',
      id,
      data: { cmd: 'echo', data: 'still-here' },
    });
    await c.waitForOutput(
      id,
      (o) => o?.type === 'echo' && o.data === 'still-here',
    );
    expect(
      (await c.request<any>({ type: 'session.get', id })).session.args,
    ).toEqual([FAKE_AGENT, '--base']);

    // a new session uses the new args
    const { ready } = await startFake(c);
    expect(ready.argv).toEqual(['--changed']);

    fs.unlinkSync(path.join(d.profilesDir, 'broken.json'));
    d.writeProfile('fake', {
      command: process.execPath,
      args: [FAKE_AGENT, '--base'],
      env: { FAKE_A: 'from-profile' },
    });
    await c.request({ type: 'profiles.reload' });
  });
});

describe('daemon restart', () => {
  it('marks sessions that were running as exited with reason daemon-restart and keeps their logs', async () => {
    const dirs = makeDirs();
    const sessionsDir = path.join(dirs.stateDir, 'sessions');
    const orphan = path.join(sessionsDir, 'orphan');
    fs.mkdirSync(orphan, { recursive: true });
    const record = {
      id: 'orphan',
      profile: 'fake',
      label: null,
      command: 'x',
      args: [],
      cwd: '/',
      env: {},
      loginShell: false,
      pid: 12345,
      state: 'running',
      exitCode: null,
      signal: null,
      exitReason: null,
      startedAt: 1,
      exitedAt: null,
      lastSeq: 0, // stale: meta is not rewritten per record
    };
    fs.writeFileSync(path.join(orphan, 'meta.json'), JSON.stringify(record));
    fs.writeFileSync(
      path.join(orphan, 'log.ndjson'),
      '{"seq":1,"t":1,"s":"out","d":"a"}\n{"seq":2,"t":2,"s":"in","d":"b"}\n',
    );
    fs.mkdirSync(path.join(sessionsDir, 'garbage'));
    fs.writeFileSync(path.join(sessionsDir, 'garbage', 'meta.json'), 'nope');

    const d2 = await startDaemon({ dirs });
    try {
      const c = await Client.connect(d2.url);
      const w = await c.request<any>({ type: 'hello', protocol: 1 });
      expect(w.sessions).toHaveLength(1);
      expect(w.sessions[0]).toMatchObject({
        id: 'orphan',
        state: 'exited',
        exitReason: 'daemon-restart',
        pid: 12345,
        exitCode: null,
        lastSeq: 2,
      });
      expect(typeof w.sessions[0].exitedAt).toBe('number');
      const attached = await c.request<any>({
        type: 'session.attach',
        id: 'orphan',
        replay: true,
      });
      expect(attached.lastSeq).toBe(2);
      expect((c.outputs('orphan') as any[]).map((f) => f.d)).toEqual([
        'a',
        'b',
      ]);
      expect(
        JSON.parse(fs.readFileSync(path.join(orphan, 'meta.json'), 'utf8'))
          .exitReason,
      ).toBe('daemon-restart');
      // and an interruption before recovery would have left the flag on disk
      expect(
        JSON.parse(fs.readFileSync(path.join(orphan, 'meta.json'), 'utf8'))
          .lastSeqUnverified,
      ).toBeUndefined();
      // the recovered boundary is on disk, so a second restart keeps it
      expect(
        JSON.parse(fs.readFileSync(path.join(orphan, 'meta.json'), 'utf8'))
          .lastSeq,
      ).toBe(2);
      expect(
        await c.request({ type: 'session.remove', id: 'orphan' }),
      ).toMatchObject({ type: 'ok' });
      await c.close();
    } finally {
      await d2.stop();
    }
  });

  it('records exits on shutdown even when a descendant holds the pipes', async () => {
    const d2 = await startDaemon({ dirs: makeDirs(), pipeGraceMs: 20000 });
    let orphanPid = 0;
    try {
      const c = await Client.connect(d2.url);
      const started = await c.request<any>({
        type: 'session.start',
        profile: 'fake',
        attach: true,
      });
      const id: string = started.session.id;
      await c.request({
        type: 'session.input',
        id,
        data: { cmd: 'orphan-hold' },
      });
      orphanPid = JSON.parse(
        (await c.waitForOutput(id, (o) => o?.type === 'orphaned')).d,
      ).pid;
      const t0 = Date.now();
      await d2.app.get(SessionsService).terminateAll();
      expect(Date.now() - t0).toBeLessThan(5000);
      const meta = JSON.parse(
        fs.readFileSync(
          path.join(d2.stateDir, 'sessions', id, 'meta.json'),
          'utf8',
        ),
      );
      expect(meta).toMatchObject({ state: 'exited', signal: 'SIGTERM' });
      expect(
        await c.request({ type: 'session.start', profile: 'fake' }),
      ).toMatchObject({ type: 'error', code: 'shutting-down' });
      await c.close();
    } finally {
      if (orphanPid) {
        try {
          process.kill(orphanPid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
      await d2.stop();
    }
  });

  it('refuses replay while the boundary is unverified and recovers it later', async () => {
    const dirs = makeDirs();
    const sessionsDir = path.join(dirs.stateDir, 'sessions');
    const dir = path.join(sessionsDir, 'unverified');
    fs.mkdirSync(dir, { recursive: true });
    const record = {
      id: 'unverified',
      profile: 'fake',
      label: null,
      command: 'x',
      args: [],
      cwd: '/',
      env: {},
      loginShell: false,
      pid: 1,
      state: 'exited',
      exitCode: null,
      signal: null,
      exitReason: 'daemon-restart',
      startedAt: 1,
      exitedAt: 2,
      lastSeq: 0,
      lastSeqUnverified: true,
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(record));
    const logPath = path.join(dir, 'log.ndjson');
    fs.writeFileSync(
      logPath,
      '{"seq":1,"t":1,"s":"out","d":"a"}\n{"seq":2,"t":2,"s":"out","d":"b"}\n',
    );
    fs.chmodSync(logPath, 0o000); // unreadable at boot: recovery must fail, not guess
    const d2 = await startDaemon({ dirs });
    try {
      const c = await Client.connect(d2.url);
      const before = await c.request<any>({
        type: 'session.get',
        id: 'unverified',
      });
      expect(before.session).toMatchObject({
        lastSeq: 0,
        lastSeqUnverified: true,
      });
      expect(
        await c.request({
          type: 'session.attach',
          id: 'unverified',
          replay: true,
        }),
      ).toMatchObject({ type: 'error', code: 'replay-failed' });
      fs.chmodSync(logPath, 0o600); // storage recovers
      const attached = await c.request<any>({
        type: 'session.attach',
        id: 'unverified',
        replay: true,
      });
      expect(attached).toMatchObject({ type: 'session.attached', lastSeq: 2 });
      expect(attached.session.lastSeqUnverified).toBeUndefined();
      expect((c.outputs('unverified') as any[]).map((f) => f.d)).toEqual([
        'a',
        'b',
      ]);
      expect(
        JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')),
      ).toMatchObject({ lastSeq: 2 });
      await c.close();
    } finally {
      await d2.stop();
    }
  });

  it('starts with no profiles when the directory is missing', async () => {
    const d2 = await startDaemon({ dirs: makeDirs(), profiles: false });
    try {
      fs.rmSync(d2.profilesDir, { recursive: true });
      const c = await Client.connect(d2.url);
      const reply = await c.request<any>({ type: 'profiles.reload' });
      expect(reply.profiles).toEqual([]);
      await c.close();
    } finally {
      await d2.stop();
    }
  });
});
