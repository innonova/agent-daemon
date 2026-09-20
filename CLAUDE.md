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

## Finishing work

Completed work is committed, pushed and deployed without asking first.
None of those needs approval; they need judgement. A change is complete
when it does what was asked, tests and lint pass at the gate (see
below), and the docs that
describe the behaviour are updated (`docs/design.md` for a behaviour
change, `README.md` for an operator-facing one). Then:

- commit on the branch you are on (these repositories work on `main`)
  with a message that says what changed and why;
- push;
- deploy: **not the daemon.** `npm run install:service` here ends every
  session, including yours. Commit and push, say in the summary that the
  install is pending, and leave it to a human.
- say in the summary what was committed, pushed and deployed.

The gate: for one feature worked alone, the gate is that feature. For
a batch (several features in one context, a helper agent's usual job),
commit once per feature with the cheap checks, do not push or deploy,
and run the full suite, lint and review once at the end; whoever closes
the batch fixes the fallout, pushes and deploys. Say in each report
whether the feature was gated alone or with its batch.

Still ask first for force-pushes, history rewrites, deleting branches,
anything that ends daemon sessions, and work beyond what was asked. When
the work is a feature from `features/`, its report and status change are
part of the work: commit and push them with it (see Features).

## You may be running inside this system

These four repositories are registered as one project in the installed
agent-manager, and agents started from it work on this very code
(dogfooding). Keep that in mind:

- The installed `agent-daemon` user service holds your own session.
  `npm run install:service` in `agent-daemon`, `systemctl --user restart
  agent-daemon` and a reboot end every session, including yours. Do not
  do that; leave it to a human. Building, unit tests and `test:e2e` are
  fine: they use ephemeral ports and their own state directories.
- Restarting the installed `agent-manager` (`npm run install:service` in
  `agent-manager`) is safe: agents live in the daemon and are re-adopted.
- `agent-manager-ui`'s Playwright suite starts its own daemon and manager
  on the fixed port 4299; only one run at a time on this machine.
- One writing agent per repository. Other repositories of the project are
  reachable at the sibling paths (`../agent-daemon`, `../agent-manager`,
  `../agent-manager-ui`, `../agent-manager-cli`); prefer editing them only
  when the task needs it,
  and say so in your summary.

## Features

Units of work live in `features/<slug>.md` in each repository
(frontmatter: title, status, priority, dependsOn; body is the spec,
followed by the conversation about it). Nothing queues them: a human
asks you, in the conversation, to work on one or more of them, possibly
with caveats. When asked:

- read the whole file first; earlier `## Report` and `## Response`
  sections are the feature's history and the human's answers to it;
- set `status: in-progress` when you start;
- when finished, append `## Report (YYYY-MM-DD)` with what you changed,
  what you verified, what you left open, and what you noticed and left
  alone (anything seen outside the feature's scope: a defect, a doubt,
  a claim you could not check), and set `status: review`;
  if you cannot or should not continue, say why in the report and set
  `status: blocked`;
- commit the file with the work; never edit the other frontmatter
  fields, and do not create or edit feature files otherwise unless asked;
- when asked to work through several or all planned features, re-read
  `features/` before finishing and take up anything planned that appeared
  meanwhile, so the batch drains rather than stops at the list you
  started with.

The human reads the report in the manager, answers under `## Response`
and sets the status back to `planned`, or marks it `done`. The
convention is specified in `../agent-manager/docs/design.md` (Features);
the practice around it, including how agents delegate to helpers, is
`../agent-manager/docs/method.md`.

## Local environment

Claude Code, Codex and Copilot CLI are installed and logged in on this box,
so real end-to-end runs are possible, and the daemon itself runs as the
`agent-daemon` user service on `127.0.0.1:4267`. `ELECTRON_RUN_AS_NODE`
leaks from IDE shells; the smoke script and the unit file already unset it,
but unset it yourself before launching the agent CLIs by hand.
