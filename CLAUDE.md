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
npm run start:dev       # watch mode
npm run build           # nest build -> dist/
npm test                # unit tests (src/**/*.spec.ts)
npm run test:e2e        # builds first; drives the protocol against a fake agent and runs dist/main.js as a real process
npm run smoke:agents    # opt-in, COSTS TOKENS on three vendors; one real turn per agent CLI
npm run install:service # RESTARTS the installed daemon and ENDS EVERY RUNNING SESSION on this box
npm run lint && npm run format
```

The tests spawn real child processes and open real sockets; they will not
run in a sandbox that forbids that.

## Working here

- **Do not restart the installed service casually.** It is the thing the
  whole project exists to keep alive. `install:service`, `systemctl --user
  restart agent-daemon` and a reboot all end every session. Check
  `sessions.list` (or `journalctl --user -u agent-daemon`) for running
  sessions before doing any of them, and say so when you do.
- **Review loop**: Codex deep review with the custom prompt for substantive
  passes, `claude -p` for cheap second opinions, reviewers report and this
  side fixes. Prompts and the how-to are in `docs/reviewing.md`.
- **Docs have audiences**: `docs/design.md` for people changing the daemon,
  `docs/client-guide.md` for people building on it, `README.md` for
  operators. A behaviour change usually touches design.md; a protocol
  change touches the client guide too.
- Prettier reformats aggressively; do not rely on exact-text matches of
  source you have not just read.

## Local environment

Claude Code, Codex and Copilot CLI are installed and logged in on this box,
so real end-to-end runs are possible, and the daemon itself runs as the
`agent-daemon` user service on `127.0.0.1:4267`. `ELECTRON_RUN_AS_NODE`
leaks from IDE shells; the smoke script and the unit file already unset it,
but unset it yourself before launching the agent CLIs by hand.
