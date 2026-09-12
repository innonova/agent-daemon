#!/usr/bin/env node
// Opt-in end-to-end check against the real agent CLIs. Costs tokens; needs
// claude, codex and copilot installed and logged in. Starts its own daemon
// on an ephemeral port with temporary config and state directories.
//
//   node scripts/smoke-agents.mjs [claude|codex|copilot ...]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT = 'Reply with exactly the word PONG and nothing else.';

const agents = {
  claude: {
    profile: {
      command: 'claude',
      args: [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
      ],
    },
    startArgs: [
      '--permission-mode',
      'bypassPermissions',
      '--model',
      'claude-haiku-4-5-20251001',
    ],
    steps: [
      () => ({ type: 'user', message: { role: 'user', content: PROMPT } }),
    ],
    done: (o) => o?.type === 'result',
    answer: (outs) =>
      outs
        .filter((o) => o?.type === 'assistant')
        .flatMap((o) => o.message?.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join(''),
  },
  codex: {
    profile: { command: 'codex', args: ['app-server'] },
    steps: [
      () => ({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'agent-daemon-smoke',
            title: 'smoke',
            version: '0',
          },
        },
      }),
      (outs) =>
        outs.some((o) => o?.id === 1 && o.result)
          ? { jsonrpc: '2.0', method: 'initialized' }
          : null,
      (outs) =>
        outs.some((o) => o?.id === 1 && o.result)
          ? {
              jsonrpc: '2.0',
              id: 2,
              method: 'thread/start',
              params: { approvalPolicy: 'never', sandbox: 'read-only' },
            }
          : null,
      (outs) => {
        const t = outs.find((o) => o?.id === 2 && o.result);
        return t
          ? {
              jsonrpc: '2.0',
              id: 3,
              method: 'turn/start',
              params: {
                threadId: t.result.thread.id,
                input: [{ type: 'text', text: PROMPT }],
              },
            }
          : null;
      },
    ],
    done: (o) =>
      o?.method === 'item/completed' && o.params?.item?.type === 'agentMessage',
    answer: (outs) =>
      outs.find(
        (o) =>
          o?.method === 'item/completed' &&
          o.params?.item?.type === 'agentMessage',
      )?.params.item.text,
  },
  copilot: {
    profile: { command: 'copilot', args: ['--acp'] },
    steps: [
      () => ({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
      }),
      (outs, cwd) =>
        outs.some((o) => o?.id === 1 && o.result)
          ? {
              jsonrpc: '2.0',
              id: 2,
              method: 'session/new',
              params: { cwd, mcpServers: [] },
            }
          : null,
      (outs) => {
        const s = outs.find((o) => o?.id === 2 && o.result);
        return s
          ? {
              jsonrpc: '2.0',
              id: 3,
              method: 'session/prompt',
              params: {
                sessionId: s.result.sessionId,
                prompt: [{ type: 'text', text: PROMPT }],
              },
            }
          : null;
      },
    ],
    done: (o) => o?.id === 3 && (o.result || o.error),
    answer: (outs) =>
      outs
        .filter(
          (o) =>
            o?.method === 'session/update' &&
            o.params?.update?.sessionUpdate === 'agent_message_chunk',
        )
        .map((o) => o.params.update.content.text)
        .join(''),
  },
};

const selected = process.argv.slice(2).length
  ? process.argv.slice(2)
  : Object.keys(agents);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-daemon-smoke-'));
const configDir = path.join(tmp, 'config');
const stateDir = path.join(tmp, 'state');
const work = path.join(tmp, 'work');
fs.mkdirSync(path.join(configDir, 'profiles'), { recursive: true });
fs.mkdirSync(work);
for (const [name, a] of Object.entries(agents)) {
  fs.writeFileSync(
    path.join(configDir, 'profiles', `${name}.json`),
    JSON.stringify(a.profile),
  );
}

const env = {
  ...process.env,
  AGENT_DAEMON_LISTEN: '127.0.0.1:0',
  AGENT_DAEMON_CONFIG_DIR: configDir,
  AGENT_DAEMON_STATE_DIR: stateDir,
};
delete env.ELECTRON_RUN_AS_NODE;
const daemon = spawn(process.execPath, [path.join(root, 'dist', 'main.js')], {
  env,
  stdio: ['ignore', 'pipe', 'inherit'],
});
const port = await new Promise((resolve, reject) => {
  let buf = '';
  daemon.stdout.on('data', (d) => {
    buf += d;
    const m = buf.match(/listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
    if (m) resolve(Number(m[1]));
  });
  daemon.on('exit', (code) =>
    reject(new Error(`daemon exited early with ${code}\n${buf}`)),
  );
});

async function run(name) {
  const a = agents[name];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const send = (o) => ws.send(JSON.stringify(o));
  const outputs = [];
  let id;
  let step = 0;
  const advance = () => {
    while (step < a.steps.length) {
      const frame = a.steps[step](outputs, work);
      if (!frame) return;
      step++;
      send({ type: 'session.input', id, data: frame });
    }
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      send({ type: 'session.signal', id, signal: 'SIGKILL' });
      reject(
        new Error(
          `${name}: timed out; last outputs: ${JSON.stringify(outputs.slice(-3)).slice(0, 600)}`,
        ),
      );
    }, 120_000);
    ws.on('open', () =>
      send({
        type: 'session.start',
        ref: 1,
        profile: name,
        cwd: work,
        attach: true,
        args: a.startArgs ?? [],
      }),
    );
    ws.on('message', (m) => {
      const f = JSON.parse(String(m));
      if (f.type === 'error')
        return reject(new Error(`${name}: ${f.code}: ${f.message}`));
      if (f.type === 'session.started') {
        id = f.session.id;
        return advance();
      }
      if (f.type === 'session.output') {
        if (f.s === 'err') process.stderr.write(`  [${name} stderr] ${f.d}\n`);
        if (f.s !== 'out') return;
        let o;
        try {
          o = JSON.parse(f.d);
        } catch {
          o = f.d;
        }
        outputs.push(o);
        if (a.done(o)) {
          clearTimeout(timer);
          send({ type: 'session.signal', id, signal: 'SIGTERM' });
          return;
        }
        return advance();
      }
      if (f.type === 'session.exit' && f.id === id) {
        ws.close();
        resolve({ answer: a.answer(outputs), lines: outputs.length, exit: f });
      }
    });
    ws.on('error', reject);
  });
}

let failed = 0;
for (const name of selected) {
  process.stdout.write(`${name}: `);
  try {
    const r = await run(name);
    const ok = (r.answer ?? '').trim() === 'PONG';
    if (!ok) failed++;
    console.log(
      `${ok ? 'OK' : 'FAIL'} answer=${JSON.stringify(r.answer)} lines=${r.lines} exit=${r.exit.exitCode ?? r.exit.signal}`,
    );
  } catch (err) {
    failed++;
    console.log(`FAIL ${err.message}`);
  }
}
daemon.kill('SIGTERM');
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
