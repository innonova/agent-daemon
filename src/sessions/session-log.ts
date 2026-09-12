import fs from 'node:fs';
import fsp from 'node:fs/promises';

export type LogStream = 'out' | 'err' | 'in';

export interface LogRecord {
  seq: number;
  t: number;
  s: LogStream;
  d: string;
}

/** Sparse seq -> byte offset map so tail reads need not scan the whole file. */
export class LogIndex {
  static readonly EVERY = 256;
  private readonly entries: { seq: number; offset: number }[] = [];

  note(seq: number, offset: number): void {
    const last = this.entries[this.entries.length - 1];
    if (!last || seq >= last.seq + LogIndex.EVERY)
      this.entries.push({ seq, offset });
  }

  /** Byte offset at or before the record with `seq`. */
  offsetFor(seq: number): number {
    let lo = 0;
    let hi = this.entries.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.entries[mid].seq <= seq) {
        best = this.entries[mid].offset;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }
}

/**
 * Append-only NDJSON log for one session. Writes are synchronous and
 * complete (short writes are retried) so that the file is always consistent
 * with the sequence numbers already handed out; that is what lets replay
 * catch up from disk and switch to live output without a gap.
 */
export class SessionLog {
  private fd: number | null;
  private size: number;

  constructor(
    readonly path: string,
    readonly index: LogIndex = new LogIndex(),
  ) {
    this.fd = fs.openSync(path, 'a');
    this.size = fs.fstatSync(this.fd).size;
  }

  append(record: LogRecord): void {
    if (this.fd === null) throw new Error('log is closed');
    const buf = Buffer.from(JSON.stringify(record) + '\n');
    const offset = this.size;
    let written = 0;
    while (written < buf.length) {
      const n = fs.writeSync(this.fd, buf, written, buf.length - written);
      if (n <= 0) throw new Error('short write');
      written += n;
      this.size += n;
    }
    this.index.note(record.seq, offset);
  }

  close(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  /**
   * Streams records with `fromSeq <= seq <= untilSeq` starting at `offset`
   * (which must be a record boundary at or before `fromSeq`). Reading stops
   * as soon as `untilSeq` is passed. Torn or unparsable lines are skipped.
   * If an index is given, it is filled in as records are passed.
   */
  static async *read(
    path: string,
    fromSeq: number,
    untilSeq = Number.MAX_SAFE_INTEGER,
    offset = 0,
    index?: LogIndex,
  ): AsyncGenerator<LogRecord> {
    let fh: fsp.FileHandle;
    try {
      fh = await fsp.open(path, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    try {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let pending: Buffer[] = [];
      let lineStart = offset;
      let pos = offset;
      for (;;) {
        const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
        if (bytesRead === 0) return;
        let start = 0;
        for (;;) {
          const nl = chunk.indexOf(10, start);
          if (nl < 0 || nl >= bytesRead) {
            pending.push(Buffer.from(chunk.subarray(start, bytesRead)));
            break;
          }
          pending.push(Buffer.from(chunk.subarray(start, nl)));
          const line = Buffer.concat(pending).toString('utf8');
          pending = [];
          const recordOffset = lineStart;
          lineStart = pos + nl + 1;
          start = nl + 1;
          if (line.length === 0) continue;
          let rec: LogRecord;
          try {
            rec = JSON.parse(line) as LogRecord;
          } catch {
            continue;
          }
          if (typeof rec.seq !== 'number') continue;
          index?.note(rec.seq, recordOffset);
          if (rec.seq > untilSeq) return;
          if (rec.seq >= fromSeq) yield rec;
        }
        pos += bytesRead;
      }
    } finally {
      await fh.close();
    }
  }

  /** The seq of the last complete record on disk, or 0. Reads only the tail. */
  static async lastSeq(path: string): Promise<number> {
    let fh: fsp.FileHandle;
    try {
      fh = await fsp.open(path, 'r');
    } catch {
      return 0;
    }
    try {
      const { size } = await fh.stat();
      let from = Math.max(0, size - 64 * 1024);
      for (;;) {
        const buf = Buffer.alloc(size - from);
        await fh.read(buf, 0, buf.length, from);
        const lines = buf.toString('utf8').split('\n');
        lines.pop(); // whatever follows the last newline is torn or empty
        if (from > 0) lines.shift(); // first line may start mid-record
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const rec = JSON.parse(lines[i]) as LogRecord;
            if (typeof rec.seq === 'number') return rec.seq;
          } catch {
            /* torn line */
          }
        }
        if (from === 0) return 0;
        from = Math.max(0, from - 1024 * 1024);
      }
    } finally {
      await fh.close();
    }
  }
}
