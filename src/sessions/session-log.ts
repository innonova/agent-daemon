import fs from 'node:fs';
import readline from 'node:readline';

export type LogStream = 'out' | 'err' | 'in';

export interface LogRecord {
  seq: number;
  t: number;
  s: LogStream;
  d: string;
}

/**
 * Append-only NDJSON log for one session. Writes are synchronous so that the
 * file is always consistent with the sequence numbers already handed out;
 * that is what makes replay-then-live seamless.
 */
export class SessionLog {
  private fd: number | null;

  constructor(readonly path: string) {
    this.fd = fs.openSync(path, 'a');
  }

  append(record: LogRecord): void {
    if (this.fd === null) throw new Error('log is closed');
    fs.writeSync(this.fd, JSON.stringify(record) + '\n');
  }

  close(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  /**
   * Streams records with `seq >= fromSeq`. The whole file is scanned; the
   * cost is linear in log size and only paid on attach.
   */
  static async *read(path: string, fromSeq = 0): AsyncGenerator<LogRecord> {
    if (!fs.existsSync(path)) return;
    const stream = fs.createReadStream(path, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (line.length === 0) continue;
        let rec: LogRecord;
        try {
          rec = JSON.parse(line) as LogRecord;
        } catch {
          continue; // a torn last line from a crash; nothing to do about it
        }
        if (rec.seq >= fromSeq) yield rec;
      }
    } finally {
      rl.close();
      stream.destroy();
    }
  }
}
