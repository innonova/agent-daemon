import { LineSplitter } from './line-splitter.js';

function make(max = 10) {
  const lines: string[] = [];
  const drops: (number | null)[] = [];
  const s = new LineSplitter(
    max,
    (l) => lines.push(l),
    (n) => drops.push(n),
  );
  return { s, lines, drops };
}

describe('LineSplitter', () => {
  it('splits complete lines across chunks', () => {
    const { s, lines } = make();
    s.push(Buffer.from('ab'));
    s.push(Buffer.from('c\nde\nf'));
    expect(lines).toEqual(['abc', 'de']);
    s.push(Buffer.from('\n'));
    expect(lines).toEqual(['abc', 'de', 'f']);
  });

  it('passes carriage returns through untouched', () => {
    const { s, lines } = make();
    s.push(Buffer.from('a\r\nb\r'));
    s.flush();
    expect(lines).toEqual(['a\r', 'b\r']);
  });

  it('flushes a trailing partial line', () => {
    const { s, lines } = make();
    s.push(Buffer.from('tail'));
    s.flush();
    expect(lines).toEqual(['tail']);
    s.flush();
    expect(lines).toEqual(['tail']);
  });

  it('drops lines over the limit and resumes at the next newline', () => {
    const { s, lines, drops } = make(5);
    s.push(Buffer.from('12345\n123456\nok\n'));
    expect(lines).toEqual(['12345', 'ok']);
    expect(drops).toEqual([null, 6]);
  });

  it('counts every byte of an oversized line split across chunks', () => {
    const { s, lines, drops } = make(5);
    s.push(Buffer.from('abc'));
    s.push(Buffer.from('def'));
    s.push(Buffer.from('ghi\nz\n'));
    expect(lines).toEqual(['z']);
    expect(drops).toEqual([null, 9]);
  });

  it('reports an oversized unterminated line on flush', () => {
    const { s, lines, drops } = make(2);
    s.push(Buffer.from('abcd'));
    s.flush();
    expect(lines).toEqual([]);
    expect(drops).toEqual([null, 4]);
  });

  it('handles multi-byte characters split across chunks', () => {
    const { s, lines } = make(100);
    const bytes = Buffer.from('héllo\n');
    s.push(bytes.subarray(0, 2));
    s.push(bytes.subarray(2));
    expect(lines).toEqual(['héllo']);
  });
});
