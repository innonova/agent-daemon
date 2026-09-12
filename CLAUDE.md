# agent-daemon

Local daemon that holds long-running headless agent CLI sessions (Claude
Code, Codex, GitHub Copilot CLI) and exposes them over a websocket on
`127.0.0.1:4267`. The design, protocol and scope decisions are in
`docs/design.md`; read it before changing behaviour, and update it when a
decision changes. It is the source of truth, not this file.

## Rules that follow from the design

- The daemon is a dumb line forwarder with a disk log. Never add code that
  parses, interprets or special-cases agent output or input. Agent protocol
  knowledge belongs in clients.
- Stability over features: this process is meant to never restart. Prefer
  leaving something out over adding a reason to redeploy later.
- Do not restrict what a client may start (args, cwd, env). It is a trusted
  local component, not a hardened service.
- No new runtime dependencies without a clear need. Nest is used because the
  author knows it well; that is the one deliberate exception to minimalism.
- Profiles are templates, sessions are instances. Reloading profiles must
  never affect a running session.

## Stack and commands

NestJS 12 on Node 24, ESM (`"type": "module"`, imports use `.js` suffix),
vitest for tests, oxlint + prettier.

```
npm run start:dev   # watch mode
npm run build       # nest build -> dist/
npm test            # vitest unit tests (src/**/*.spec.ts)
npm run test:e2e    # vitest, test/**
npm run lint
npm run format
```

## Local environment

Claude Code, Codex and Copilot CLI are installed and logged in on this box,
so real end-to-end runs are possible. `ELECTRON_RUN_AS_NODE` may leak from
IDE shells; unset it before launching anything Electron-based, though this
project itself is plain Node.
