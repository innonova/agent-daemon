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

- Linux with systemd user services. The daemon's installer runs
  `loginctl enable-linger` so the services outlive your login; over a
  plain SSH session on a host with strict polkit it can fail, in which
  case the installer prints a warning and both services stop at logout
  until you run it with a privilege that works.
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
- **cli**: builds `dist/` in the checkout and writes `~/.local/bin/am`,
  a wrapper that runs it from there. `~/.local/bin` must be on your
  PATH; moving or deleting the checkout breaks the command, and a
  `npm run build` in the checkout changes the installed command at once.

Then open `http://<host>:4268/`, log in as `admin`, and create a project
(a name and the absolute paths of its repositories, the first one
primary) and an agent in it.

## 3. Configure

- **More users**: the web UI's Users page creates one with a generated
  password shown once, and renames, resets and removes. From the shell,
  `cd ~/projects/agent-manager && npm run user:add -- alice` asks for a
  password (or takes `AGENT_MANAGER_NEW_PASSWORD`). Every user is a
  trusted admin.
- **The admin password**: `AGENT_MANAGER_ADMIN_PASSWORD` creates `admin`
  on the first start only, when no user exists; giving another value on
  a reinstall changes nothing (reset it from the Users page instead).
  The installer stores it, when given, in
  `~/.config/systemd/user/agent-manager.service.d/admin.conf` (mode 600),
  in the clear; remove that file after the first start if you would
  rather not keep it, the manager does not need it again.
- **Profiles**: how the daemon starts each kind of agent; see the next
  section.
- **What agents are told**: every agent gets a short note at session
  start saying it runs under agent-manager (nobody at a terminal, what a
  mid-turn message is, the features convention, its project and repos).
  The built-in text is in `agent-manager/src/agents/harness.ts`; put
  your own in `~/.config/agent-manager/harness.md` (placeholders
  `{{agent}}`, `{{project}}`, `{{host}}`, `{{repos}}`, `{{cwd}}`,
  `{{permissions}}`; an empty file turns the note off). It is read at
  each session start, so an edit reaches an agent at its next restart
  ("save and restart agents" on the project, or `am project restart`).
  Each machine has its own file. The web UI shows what an agent was
  told behind "harness" in its header.
- **Behind TLS** (a reverse proxy in front of `:4268`): set
  `AGENT_MANAGER_PUBLIC_ORIGIN` and `AGENT_MANAGER_TRUSTED_PROXIES` in a
  systemd drop-in, and keep the proxy's idle timeout above the manager's
  websocket ping interval. The manager README's "Behind a reverse proxy"
  section has the drop-in and an nginx example; the installer leaves
  `proxy.conf` alone (it rewrites only `admin.conf`, and only when the
  variable is set).
- **Other settings**: environment variables in the same drop-in; the
  tables are in `agent-daemon/docs/design.md` and
  `agent-manager/docs/design.md` (Configuration).
- **The CLI**: `am login`, then `am` for the TUI or `am help` for the
  commands. A login lasts `AGENT_MANAGER_SESSION_TTL_MS` (30 days); after
  that every command says to log in again. Shift+Enter inserts a newline where the terminal sends a
  distinct key for it (Git Bash does; Windows Terminal needs one binding,
  see the CLI README); Ctrl+J works everywhere.

## 3a. Profiles

A profile is one JSON file in `~/.config/agent-daemon/profiles/`, named
after the agent it starts, saying how to run that agent CLI headless.
The daemon's installer writes `claude`, `codex` and `copilot` if they do
not exist; the manager's installer writes `fake`. The installed set:

```
claude.json   claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages
codex.json    codex app-server
copilot.json  copilot --acp
fake.json     node ~/.local/lib/agent-manager/fixtures/fake-agent.mjs   (costs no tokens; for trying things)
```

The fields, all but `command` optional:

```json
{
  "description": "Claude Code, headless stream-json",
  "command": "claude",
  "args": ["-p", "--input-format", "stream-json", "…"],
  "cwd": null,
  "env": {},
  "loginShell": false
}
```

- `command` is resolved against the daemon service's PATH, which the
  installer copies from the shell that ran it. An agent CLI installed
  later, or one that only works with your shell profile loaded (nvm,
  tokens in `.bashrc`), needs either `loginShell: true`, which runs the
  command through `$SHELL -lc`, or a reinstall of the daemon from a
  shell that has it on the PATH (that restart ends every session).
- `args` are the base arguments; the manager appends its own per agent
  (the working directory's extra repositories, permission mode, model,
  effort, resume), so keep the protocol flags and add only what applies
  to every agent of that kind.
- `env` is merged over the daemon's environment, per profile.

Two rules that follow from how the pieces fit:

- **The name is the contract.** The manager has one adapter per vendor
  protocol, keyed by profile name: `claude`, `codex`, `copilot`, `fake`.
  The web UI's "new agent" only offers profiles the manager supports, so
  a profile under another name is listed but unusable. A variant (a
  different model, a different working setup) is an agent setting, not
  a new profile.
- **Edits take effect on reload, not on running agents**:
  `systemctl --user reload agent-daemon`. Sessions already started keep
  the command they were started with; the next session an agent starts
  (after a stop, or "save and restart agents" in the project form) uses
  the new profile.

Installer overrides, for an unusual layout: `AGENT_DAEMON_INSTALL_DIR`,
`AGENT_DAEMON_CONFIG_DIR` (daemon); `AGENT_MANAGER_INSTALL_DIR`,
`AGENT_MANAGER_UI_DIST` (manager, also `install:ui`);
`AGENT_MANAGER_CLI_BIN` (where the `am` wrapper goes).

## 3b. Several machines

Repeat steps 1 to 3 on each machine; each runs its own daemon and
manager. To work on all of them from one UI, pick one manager as the
hub. On every other machine (a spoke), install the manager with a
shared secret, which the installer keeps in the `hub.conf` drop-in:

```
AGENT_MANAGER_HUB_TOKEN='<long random string>' npm run install:service
```

The spoke's port 4268 must be reachable from the hub (a LAN or VPN
address; the spoke needs no TLS front of its own since only the hub
talks to it, but keep the port off the internet). On the hub, list the
spokes in `~/.local/state/agent-manager/spokes.json` and restart it:

```
[{ "name": "vibe", "url": "http://192.168.1.20:4268", "token": "<the same string>" }]
systemctl --user restart agent-manager
```

The hub's project list now shows every machine's projects with the
machine's name, and everything about them (agents, transcripts, files,
changes, features) works through the hub as the user logged in there,
who is created on the spoke by name. The agent CLIs must be installed
and logged in on each machine that runs agents; a spoke without them
can still run the `fake` profile. `../agent-manager/docs/design.md`
(Hub and spokes) has the details and the limits.

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
| manager overrides | `~/.config/systemd/user/agent-manager.service.d/*.conf` (`admin.conf` holds the first-start password in the clear) |
| CLI login | `~/.config/agent-manager-cli/session.json` |

Backups: the daemon's state directory and the manager's database are the
data; everything else is reproducible from the repositories. The
manager's `transcripts/` is a cache rebuilt from the daemon's logs.
