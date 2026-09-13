# Installing the whole setup

Four repositories, one machine, one user account, no root. Everything
runs as systemd user services under `~/.local/lib`, with config in
`~/.config` and state in `~/.local/state`.

| Part | What it is | Listens on |
|---|---|---|
| `agent-daemon` | holds the agent CLI processes; never restart it casually | `127.0.0.1:4267` |
| `agent-manager` | projects, agents, users, the API; serves the web UI | `0.0.0.0:4268` |
| `agent-manager-ui` | the browser UI, built into the manager's install | (via the manager) |
| `agent-manager-cli` | `am`: plain commands and a chat TUI for an SSH shell | (talks to 4268) |

## 1. Prerequisites

- Linux with systemd user services (`loginctl enable-linger` is done by
  the daemon's installer so the services outlive your login).
- Node 24 and git.
- The agent CLIs you want, installed and logged in **as this user**:
  Claude Code (`claude`), Codex (`codex`), GitHub Copilot CLI (`copilot`).
  Try each once by hand; the daemon only runs what already works.
- The four repositories cloned side by side, since they refer to each
  other as `../<name>`:

```
mkdir -p ~/projects && cd ~/projects
git clone git@github.com:innonova/agent-daemon.git
git clone git@github.com:innonova/agent-manager.git
git clone git@github.com:innonova/agent-manager-ui.git
git clone git@github.com:innonova/agent-manager-cli.git
```

## 2. Install, in this order

```
cd ~/projects/agent-daemon      && npm install && npm run install:service
cd ~/projects/agent-manager-ui  && npm install && npm run build
cd ~/projects/agent-manager     && npm install && AGENT_MANAGER_ADMIN_PASSWORD='choose one' npm run install:service
cd ~/projects/agent-manager-cli && npm install && npm run install:cli
```

What each step does:

- **daemon**: builds, installs to `~/.local/lib/agent-daemon`, starts the
  `agent-daemon` user service, and writes default `claude`, `codex` and
  `copilot` profiles to `~/.config/agent-daemon/profiles/` if none exist.
  `curl http://127.0.0.1:4267/health` should answer.
- **UI build**: produces `dist/`, which the manager's installer copies.
  Without it the manager runs API-only.
- **manager**: builds, installs to `~/.local/lib/agent-manager` with the
  UI, writes a `fake` profile into the daemon (an agent that costs no
  tokens, for trying things), reloads the daemon's profiles (a reload,
  not a restart), starts the `agent-manager` user service on `:4268`, and
  creates the `admin` user with the password given.
- **cli**: builds and links `~/.local/bin/am`.

Then open `http://<host>:4268/`, log in as `admin`, and create a project
(a name and the absolute paths of its repositories, the first one
primary) and an agent in it.

## 3. Configure

- **More users**: `cd ~/projects/agent-manager && npm run user:add -- alice`
  prints a generated password once. Every user is a trusted admin; the
  web UI's Users page renames, resets and removes.
- **Profiles**: `~/.config/agent-daemon/profiles/<name>.json` is the
  command and arguments for one agent CLI. Edit, then
  `systemctl --user reload agent-daemon`; running sessions are untouched.
- **Behind TLS** (a reverse proxy in front of `:4268`): set
  `AGENT_MANAGER_PUBLIC_ORIGIN` and `AGENT_MANAGER_TRUSTED_PROXIES` in a
  systemd drop-in, and keep the proxy's idle timeout above the manager's
  websocket ping interval. The manager README's "Behind a reverse proxy"
  section has the drop-in and an nginx example; the installer leaves
  drop-ins alone.
- **Other settings**: environment variables in the same drop-in; the
  tables are in `agent-daemon/docs/design.md` and
  `agent-manager/docs/design.md` (Configuration).
- **The CLI**: `am login` once, then `am` for the TUI or `am help` for
  the commands. Shift+Enter inserts a newline where the terminal sends a
  distinct key for it (Git Bash does; Windows Terminal needs one binding,
  see the CLI README); Ctrl+J works everywhere.

## 4. Upgrade

```
cd ~/projects/agent-manager-ui && git pull && npm install && npm run build
cd ~/projects/agent-manager    && git pull && npm install && npm run install:service   # manager + UI; agents unaffected
cd ~/projects/agent-manager-cli && git pull && npm install && npm run install:cli
```

UI only: `npm run build` there, then `npm run install:ui` in the manager
(no restart; open tabs offer a reload). The daemon:

```
cd ~/projects/agent-daemon && git pull && npm install && npm run install:service   # ENDS EVERY AGENT SESSION
```

Do that only when nothing is running that you mind losing; `am agents
<project>` or the web UI shows what is. Agents resume their conversation
on the next turn afterwards, but a turn in flight is cut.

## 5. Where things are

| | |
|---|---|
| installs | `~/.local/lib/agent-daemon`, `~/.local/lib/agent-manager` (+ `ui/`), `~/.local/bin/am` |
| services | `systemctl --user status agent-daemon agent-manager`; logs with `journalctl --user -u <name> -f` |
| daemon profiles and state | `~/.config/agent-daemon/profiles/`, `~/.local/state/agent-daemon/sessions/<id>/` (the logs of record) |
| manager database and cache | `~/.local/state/agent-manager/` (`manager.db`, `transcripts/`) |
| manager overrides | `~/.config/systemd/user/agent-manager.service.d/*.conf` |
| CLI login | `~/.config/agent-manager-cli/session.json` |

Backups: the daemon's state directory and the manager's database are the
data; everything else is reproducible from the repositories. The
manager's `transcripts/` is a cache rebuilt from the daemon's logs.
