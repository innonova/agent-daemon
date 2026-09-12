/**
 * Splits a byte stream into lines on `\n` only; bytes are otherwise passed
 * through untouched. Bounded: once the pending partial line exceeds
 * `maxBytes` it is discarded, `onOverflow(null)` is called immediately, and
 * when the line finally ends (or the stream does) `onOverflow(total)` is
 * called with the number of bytes dropped. Splitting resumes at the next
 * newline.
 */
export class LineSplitter {
  private chunks: Buffer[] = [];
  private pending = 0;
  private dropping = false;
  private dropped = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly onLine: (line: string) => void,
    private readonly onOverflow: (droppedBytes: number | null) => void,
  ) {}

  push(chunk: Buffer): void {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(10, start);
      if (nl < 0) {
        this.append(chunk.subarray(start));
        return;
      }
      this.append(chunk.subarray(start, nl));
      this.finishLine();
      start = nl + 1;
    }
  }

  /** Emits a trailing partial line, if any. Call when the stream ends. */
  flush(): void {
    if (this.dropping) {
      this.reportDrop();
    } else if (this.pending > 0) {
      this.finishLine();
    }
  }

  private append(part: Buffer): void {
    if (part.length === 0) return;
    if (this.dropping) {
      this.dropped += part.length;
      return;
    }
    if (this.pending + part.length > this.maxBytes) {
      this.dropping = true;
      this.dropped = this.pending + part.length;
      this.chunks = [];
      this.pending = 0;
      this.onOverflow(null);
      return;
    }
    this.chunks.push(part);
    this.pending += part.length;
  }

  private finishLine(): void {
    if (this.dropping) {
      this.reportDrop();
      return;
    }
    const line =
      this.chunks.length === 1
        ? this.chunks[0].toString('utf8')
        : Buffer.concat(this.chunks).toString('utf8');
    this.chunks = [];
    this.pending = 0;
    this.onLine(line);
  }

  private reportDrop(): void {
    const n = this.dropped;
    this.dropping = false;
    this.dropped = 0;
    this.onOverflow(n);
  }
}
