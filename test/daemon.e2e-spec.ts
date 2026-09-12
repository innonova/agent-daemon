import fs from 'node:fs';
import path from 'node:path';
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
    const note = await c.waitFor(
      (f) =>
        f.type === 'session.output' &&
        (f as any).s === 'err' &&
        (f as any).id === id,
    );
    expect((note as any).d).toBe(
      'agent-daemon: dropped 100000 bytes exceeding line limit on stdout',
    );
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
    expect(await c.request({ type: 'session.remove', id })).toMatchObject({
      type: 'ok',
    });
    expect(fs.existsSync(dir)).toBe(false);
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
      lastSeq: 2,
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
        pid: null,
        exitCode: null,
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
      expect(
        await c.request({ type: 'session.remove', id: 'orphan' }),
      ).toMatchObject({ type: 'ok' });
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
