// A stand-in for an agent CLI: newline-delimited JSON in, newline-delimited
// JSON out, plus knobs to produce stderr, huge lines, partial lines, exits.
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

out({
  type: 'ready',
  pid: process.pid,
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: {
    FAKE_A: process.env.FAKE_A ?? null,
    FAKE_B: process.env.FAKE_B ?? null,
    FAKE_LOGIN: process.env.FAKE_LOGIN ?? null,
  },
});

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    out({ type: 'bad-input', line });
    return;
  }
  switch (msg.cmd) {
    case 'echo':
      out({ type: 'echo', data: msg.data });
      break;
    case 'stderr':
      process.stderr.write(msg.text + '\n');
      break;
    case 'big':
      process.stdout.write('x'.repeat(msg.bytes) + '\n');
      break;
    case 'spam':
      for (let i = 0; i < msg.n; i++) out({ type: 'spam', i });
      break;
    case 'partial':
      process.stdout.write(msg.text); // no newline
      break;
    case 'trap-int':
      process.on('SIGINT', () => {
        out({ type: 'sigint' });
        process.exit(130);
      });
      out({ type: 'trapped' });
      break;
    case 'pause-stdin':
      process.stdin.pause();
      setInterval(() => {}, 1000); // a paused stdin no longer keeps the loop alive
      out({ type: 'paused' });
      break;
    case 'orphan-hold': {
      // keep running while a grandchild also holds our stdout
      const kid = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        {
          stdio: ['ignore', 'inherit', 'inherit'],
          detached: true,
        },
      );
      kid.unref();
      out({ type: 'orphaned', pid: kid.pid });
      break;
    }
    case 'orphan': {
      // leave a grandchild holding our stdout open, then exit
      const kid = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        {
          stdio: ['ignore', 'inherit', 'inherit'],
          detached: true,
        },
      );
      kid.unref();
      out({ type: 'orphaned', pid: kid.pid });
      process.exit(0);
      break;
    }
    case 'exit':
      process.exit(msg.code ?? 0);
      break;
    default:
      out({ type: 'unknown-cmd', cmd: msg.cmd });
  }
});
rl.on('close', () => {
  out({ type: 'stdin-closed' });
  process.exit(0);
});
