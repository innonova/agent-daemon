import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LogIndex, SessionLog } from './session-log.js';

async function collect(
  p: string,
  from = 1,
  until?: number,
  offset?: number,
  index?: LogIndex,
) {
  const out = [];
  for await (const r of SessionLog.read(p, from, until, offset, index))
    out.push(r);
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

  it('rejects a missing file, but lastSeq treats it as empty', async () => {
    const missing = path.join(path.dirname(file), 'nope.ndjson');
    await expect(collect(missing)).rejects.toThrow(/ENOENT/);
    expect(await SessionLog.lastSeq(missing)).toBe(0);
  });

  it('stops reading when cancelled', async () => {
    const log = new SessionLog(file);
    for (let i = 1; i <= 20000; i++)
      log.append({ seq: i, t: i, s: 'out', d: 'z'.repeat(100) });
    log.close();
    let calls = 0;
    const out = [];
    for await (const r of SessionLog.read(
      file,
      19990,
      undefined,
      0,
      undefined,
      () => ++calls > 2,
    ))
      out.push(r);
    expect(out).toEqual([]); // cancelled long before the requested tail
  });

  it('stops at untilSeq and resumes from an indexed offset', async () => {
    const index = new LogIndex();
    const log = new SessionLog(file, index);
    for (let i = 1; i <= 1000; i++)
      log.append({ seq: i, t: i, s: 'out', d: 'x'.repeat(50) });
    log.close();
    expect((await collect(file, 1, 3)).map((r) => r.seq)).toEqual([1, 2, 3]);
    const offset = index.offsetFor(900);
    expect(offset).toBeGreaterThan(0);
    const tail = await collect(file, 900, undefined, offset);
    expect(tail.map((r) => r.seq)).toEqual(
      Array.from({ length: 101 }, (_, i) => 900 + i),
    );
    const built = new LogIndex();
    await collect(file, 1, undefined, 0, built);
    expect(built.offsetFor(900)).toBe(offset);
    expect(built.offsetFor(1)).toBe(0);
  });

  it('recovers the last complete seq from the tail, ignoring a torn line', async () => {
    expect(await SessionLog.lastSeq(file)).toBe(0);
    const log = new SessionLog(file);
    for (let i = 1; i <= 5000; i++)
      log.append({ seq: i, t: i, s: 'out', d: 'y'.repeat(100) });
    log.close();
    expect(await SessionLog.lastSeq(file)).toBe(5000);
    fs.appendFileSync(file, '{"seq":5001,"t":1,"s":"out","d":"tor');
    expect(await SessionLog.lastSeq(file)).toBe(5000);
  });

  it('starts a new line after a partial write so the next record stays readable', async () => {
    const log = new SessionLog(file);
    log.append({ seq: 1, t: 1, s: 'out', d: 'a' });
    const real = fs.writeSync;
    let calls = 0;
    const spy = vi
      .spyOn(fs, 'writeSync')
      .mockImplementation((fd: number, buf: any, off?: any, len?: any) => {
        calls++;
        if (calls === 1) {
          real(fd, buf, 0, 5); // five bytes land, then the disk fails
          throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
        }
        return real(fd, buf, off, len);
      });
    try {
      expect(() => log.append({ seq: 2, t: 2, s: 'out', d: 'b' })).toThrow(
        'ENOSPC',
      );
      log.append({ seq: 3, t: 3, s: 'out', d: 'c' });
    } finally {
      spy.mockRestore();
    }
    log.close();
    expect((await collect(file)).map((r) => r.seq)).toEqual([1, 3]);
    expect(await SessionLog.lastSeq(file)).toBe(3);
  });

  it('refuses to append after close', () => {
    const log = new SessionLog(file);
    log.close();
    expect(() => log.append({ seq: 1, t: 1, s: 'out', d: 'a' })).toThrow();
  });
});
