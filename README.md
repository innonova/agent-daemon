# agent-daemon

A local daemon that holds long-running headless agent CLI sessions (Claude
Code, Codex, GitHub Copilot CLI) and exposes them over a websocket, so the
tools and UIs built on top can be rebuilt freely while agents keep working.

It is deliberately dumb: it starts a process from a profile, forwards lines
between the process and websocket clients, and appends every line to a log
on disk so a client can reattach and replay. It never parses what the agents
say.

Installing all four parts together: [docs/install.md](docs/install.md).

## Quickstart

```
npm install
npm run install:service        # build, install to ~/.local/lib/agent-daemon, start the user service
curl http://127.0.0.1:4267/health
```

The install writes default `claude`, `codex` and `copilot` profiles to
`~/.config/agent-daemon/profiles/` if none exist. Session state and logs
live in `~/.local/state/agent-daemon/sessions/<id>/`.

```
systemctl --user reload agent-daemon    # re-read profiles; running sessions are untouched
journalctl --user -u agent-daemon -f    # daemon log
systemctl --user restart agent-daemon   # ENDS EVERY SESSION; only for upgrades
```

Re-running `npm run install:service` upgrades and restarts the service,
which also ends every session.

## Where to read next

- Building something on top: [docs/client-guide.md](docs/client-guide.md),
  the protocol from a client's point of view with a worked Claude example.
- Changing the daemon: [docs/design.md](docs/design.md), the specification
  and the record of every decision and why.
- Reviewing changes: [docs/reviewing.md](docs/reviewing.md), the review loop
  and the prompts that found the real bugs.

## Development

```
npm test              # unit tests
npm run test:e2e      # builds, then drives the protocol against a fake agent and the real process
npm run smoke:agents  # opt-in: one real turn through each installed agent CLI (costs tokens)
npm run lint && npm run format
```
