# agent-daemon

A local daemon that holds long-running headless agent CLI sessions (Claude
Code, Codex, GitHub Copilot CLI) and exposes them over a websocket, so the
tools and UIs built on top can be rebuilt freely while agents keep working.

See [docs/design.md](docs/design.md) for the design, scope decisions and
protocol draft.
