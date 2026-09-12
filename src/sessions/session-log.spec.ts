import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionLog } from './session-log.js';

async function collect(p: string, from?: number) {
  const out = [];
  for await (const r of SessionLog.read(p, from)) out.push(r);
  return out;
}

describe('SessionLog', () => {
  let file: string;
  beforeEach(() => {
    file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'session-log-')),
      'log.ndjson',
    );
  });

  it('appends and reads records back in order', async () => {
    const log = new SessionLog(file);
    log.append({ seq: 1, t: 1, s: 'out', d: 'a' });
    log.append({ seq: 2, t: 2, s: 'in', d: 'b' });
    log.append({ seq: 3, t: 3, s: 'err', d: 'c' });
    log.close();
    expect((await collect(file)).map((r) => r.d)).toEqual(['a', 'b', 'c']);
    expect((await collect(file, 3)).map((r) => r.seq)).toEqual([3]);
    expect(await collect(file, 4)).toEqual([]);
  });

  it('is readable while still open for writing', async () => {
    const log = new SessionLog(file);
    log.append({ seq: 1, t: 1, s: 'out', d: 'a' });
    expect((await collect(file)).length).toBe(1);
    log.append({ seq: 2, t: 2, s: 'out', d: 'b' });
    expect((await collect(file)).length).toBe(2);
    log.close();
  });

  it('skips a torn trailing line', async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ seq: 1, t: 1, s: 'out', d: 'a' }) + '\n{"seq":2,"t":',
    );
    expect((await collect(file)).map((r) => r.seq)).toEqual([1]);
  });

  it('yields nothing for a missing file', async () => {
    expect(await collect(path.join(path.dirname(file), 'nope.ndjson'))).toEqual(
      [],
    );
  });

  it('refuses to append after close', () => {
    const log = new SessionLog(file);
    log.close();
    expect(() => log.append({ seq: 1, t: 1, s: 'out', d: 'a' })).toThrow();
  });
});
