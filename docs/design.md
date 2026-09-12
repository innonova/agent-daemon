# agent-daemon design

Status: draft, 2026-09-12. Nothing here is implemented yet.

## Purpose

A local daemon that starts agentic CLIs (Claude Code, Codex, GitHub Copilot
CLI, and anything else with a comparable headless mode), keeps them running,
and exposes them over a websocket. Its sole job is to *hold the sessions* so
that everything built on top of it, in particular the user-facing UI, can be
torn down and rebuilt while an agent is in the middle of a task, without the
agent noticing.

It is one component of a larger local system. Other concerns (one-shot
commands, directory listings, remote access, auth) belong to other services
running on the same machine.

## Principles

1. **It does not restart.** Sessions live in this process. Its stability is
   what the whole system leans on, so it must almost never need a deploy.
2. **It is dumb.** It forwards lines and appends them to disk. It never
   parses, validates or interprets what the agents say. All knowledge of
   Claude's stream-json, Codex's app-server JSON-RPC or Copilot's ACP lives
   in clients. When the vendors change their protocols, the daemon does not
   change.
3. **It is not agent-specific.** Session ids, resume flags, permission
   handling and models are all just arguments and lines to the daemon.
4. **It is local and trusted.** It binds to loopback (or a unix socket) with
   no authentication, and spawns whatever the client asks for. Hardening is
   explicitly out of scope; it is not public facing.
5. **Minimal dependencies.** Node, NestJS (chosen for familiarity, not
   necessity), a websocket library. Nothing else unless unavoidable.

## Decisions and why

| Decision | Reason |
|---|---|
| Headless stdio modes only, no PTY | All target agents speak newline-delimited JSON over stdin/stdout. Pipes are simpler than PTYs, need no resize or terminal emulation, and give exact replay. PTY can be added as a second session kind later if a real need appears. |
| No tmux or per-session holder processes | Wrapping the thing that must not restart in another thing that must not restart is the same problem twice. |
| No support for non-agent CLIs (gh etc.) | Out of scope. `gh` is a one-shot tool the agents call themselves; it only needs to be on PATH. |
| Profiles are templates, sessions are instances | Reloading profiles must never touch a running process. |
| Clients may pass arbitrary extra args, cwd and env at start | The daemon is part of a trusted system. Flexibility beats validation. |
| Replay from disk, not memory | Sessions can run for days and emit partial-message events; memory must stay flat. |
| Profiles are JSON files in a directory | No parser dependency, trivially written by tooling as well as by hand. |
| Everything goes through the websocket | One connection per client carries control and data. HTTP is limited to a health check. |

## Target agents and their headless modes

Verified 2026-09-12 on this machine.

| Agent | Long-lived multi-turn mode | Notes |
|---|---|---|
| Claude Code 2.1.269 | `claude -p --input-format stream-json --output-format stream-json --verbose` | Own NDJSON dialect. `--include-partial-messages` for token streaming, `--replay-user-messages` for input acks. Permission prompts arrive as `control_request` and are answered with `control_response` on stdin. `--resume <id>` / `--session-id <uuid>` for continuity. |
| Codex 0.154.0 | `codex app-server` | JSON-RPC over stdio. `codex exec --json` for one-shot. |
| Copilot CLI 1.0.83 | `copilot --acp` | Agent Client Protocol (JSON-RPC over stdio). `copilot -p ... --output-format json` for one-shot. `--resume` / `--session-id` for continuity. |

Any future profile must provide a command that reads newline-delimited JSON
on stdin and writes newline-delimited JSON on stdout.

## Profiles

Directory: `$AGENT_DAEMON_CONFIG_DIR`, default `~/.config/agent-daemon/`.
Profiles live in `profiles/*.json`, one profile per file, file stem is the
profile name unless `name` is set.

```json
{
  "name": "claude",
  "description": "Claude Code, headless stream-json",
  "command": "claude",
  "args": [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--replay-user-messages"
  ],
  "cwd": null,
  "env": {},
  "loginShell": false
}
```

Fields:

- `command` (required): executable, resolved against the daemon's PATH.
- `args`: base arguments. A start request's `args` are appended after these.
- `cwd`: default working directory; `null` means the daemon's cwd. A start
  request may override it.
- `env`: variables merged over the daemon's environment. A start request's
  `env` is merged on top of that.
- `loginShell`: when true, spawn through `$SHELL -lc '<command> <args>'` so
  that nvm, PATH additions and tokens from the user's shell profile apply.
  Needed because a systemd user service does not inherit the interactive
  shell environment.

Profiles are loaded at startup, on `SIGHUP` (wired to `systemctl --user
reload`), and on the `profiles.reload` websocket request. A reload replaces
the profile set atomically and emits `profiles.changed`. Running sessions
keep the command line they were started with.

## Sessions

A session is one child process started from a profile. It has:

- `id`: uuid assigned by the daemon (a client may supply its own at start).
- `profile`, `label`, resolved `command`, `args`, `cwd`, `env` (as started).
- `state`: `running` or `exited`, plus `exitCode` / `signal` when exited.
- `startedAt`, `exitedAt`.
- A log on disk (below).

Exited sessions are retained, with their logs, until a client removes them.
The daemon applies no retention policy; housekeeping is a client concern.

When the daemon starts, any session recorded as `running` in the state
directory is marked `exited` with reason `daemon-restart`. Its log stays, so
a client can inspect it and start a fresh session with the agent's own
resume arguments if it wants to continue.

### On disk

State directory: `$AGENT_DAEMON_STATE_DIR`, default
`~/.local/state/agent-daemon/`.

```
sessions/<id>/meta.json     session record, rewritten on state change
sessions/<id>/log.ndjson    append-only, one record per line
```

Log record:

```json
{"seq":123,"t":1757653200123,"s":"out","d":"{\"type\":\"assistant\",...}"}
```

- `seq`: monotonically increasing per session across all streams.
- `t`: unix ms.
- `s`: `out` (stdout line), `err` (stderr line), `in` (line written to stdin).
- `d`: the line without its trailing newline. stdout and stdin lines are
  JSON by contract but the daemon stores them as opaque strings.

Recording stdin lets a client rebuild the whole conversation from the log
alone. The daemon keeps no line history in memory; replay reads the file.

## Websocket protocol

Endpoint: `ws://127.0.0.1:4267/`. TCP only, no unix socket, to keep client
configuration uniform. Host and port come from `AGENT_DAEMON_LISTEN`
(default `127.0.0.1:4267`). `GET /health` over HTTP returns 200.

Every frame is a JSON object with a `type`. Client requests carry a `ref`
(any string the client chooses); the daemon's direct reply to a request
carries the same `ref`. Events that are not replies have no `ref`.

### Client → daemon

| type | fields | reply |
|---|---|---|
| `hello` | `protocol: 1` | `welcome { protocol, version, profiles[], sessions[] }` |
| `profiles.list` | | `profiles { profiles[] }` |
| `profiles.reload` | | `profiles { profiles[] }`, plus `profiles.changed` event to all |
| `sessions.list` | | `sessions { sessions[] }` |
| `session.start` | `profile, args?, argsReplace?, cwd?, env?, label?, id?, attach?: bool, replay?` | `session.started { session }` |
| `session.attach` | `id, replay?: false \| true \| { fromSeq }` | replayed `session.output` frames, then `session.attached { session, lastSeq }` |
| `session.detach` | `id` | `session.detached { id }` |
| `session.input` | `id, data` | `ok` |
| `session.signal` | `id, signal: "SIGINT" \| "SIGTERM" \| "SIGKILL"` | `ok` |
| `session.end-input` | `id` | `ok` (closes stdin; for one-shot modes) |
| `session.remove` | `id` | `ok` (only when exited; deletes the log) |
| `session.get` | `id` | `session { session }` |

`session.start.args` are appended to the profile's base args. If
`argsReplace` is given instead, it replaces the base args entirely; the
profile then only contributes `command`, `cwd`, `env` and `loginShell`. The
daemon does not judge whether the result makes sense.

`session.input.data` is either a string, written verbatim plus `\n`, or a
JSON value, which the daemon serialises with `JSON.stringify` and writes
plus `\n`. Serialising is the daemon's only convenience; it attaches no
meaning to the content.

Attachment is per connection. A connection may be attached to any number of
sessions, and a session may have any number of attached connections, all of
which receive its output. Input is accepted from any connection, attached or
not. Closing the connection detaches it from everything; it never affects the
sessions.

### Daemon → client

| type | fields |
|---|---|
| `session.output` | `id, seq, t, s, d` (same shape as the log record) |
| `session.exit` | `id, exitCode, signal, exitedAt` |
| `session.changed` | `session` (state or metadata change) |
| `profiles.changed` | `profiles[]` |
| `error` | `ref?, id?, code, message` |
| `ok` | `ref` |

Replay: on attach with replay, the daemon streams the log file from the
requested `seq` as `session.output` frames, buffering live output produced
meanwhile, then flushes the buffer and sends `session.attached`. From that
point the client receives live frames. `seq` is contiguous, so a client that
reconnects asks for `{ fromSeq: lastSeen + 1 }` and misses nothing.

Backpressure: if a client's socket buffer grows beyond a threshold the
daemon drops that client's attachments and sends an `error` with code
`slow-consumer`; it never blocks or buffers unboundedly on behalf of a
client. The log on disk remains authoritative and the client may reattach
with replay.

## Process management

- Children are spawned with `stdio: ['pipe', 'pipe', 'pipe']` and
  `detached: false`. They are in the daemon's process group and die with it,
  which is the intended and accepted behaviour.
- stdout and stderr are split on `\n`. A final partial line at exit is
  emitted as a line.
- A single line is limited to 10 MB (`AGENT_DAEMON_MAX_LINE`, bytes). This
  is purely a memory bound against a child that stops emitting newlines; it
  is not expected to trigger with real agents. When exceeded, the buffered
  bytes are discarded, a record `{"s":"err","d":"agent-daemon: dropped
  <n> bytes exceeding line limit on <stream>"}` is logged and sent, and
  reading continues from the next newline.
- No automatic restart of exited children. Resume is an agent feature the
  client drives through arguments.

## Running it

Intended as a systemd **user** service, because the agents' credentials and
config live in the user's home directory.

```ini
[Unit]
Description=agent-daemon

[Service]
ExecStart=/usr/bin/node /opt/agent-daemon/dist/main.js
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
Environment=AGENT_DAEMON_LISTEN=127.0.0.1:4267

[Install]
WantedBy=default.target
```

Note: `ELECTRON_RUN_AS_NODE` and similar variables leaking from IDE shells
must not reach the service environment.

## Out of scope

Authentication, TLS, remote access, one-shot command execution, filesystem
browsing, session retention policies, PTY sessions, any parsing of agent
output. These belong to the services and UIs built on top.

## Resolved questions

- Port 4267, TCP on loopback. No unix socket: TCP is uniform for every
  client and causes less confusion.
- 10 MB per-line limit as a crash guard only.
- `argsReplace` is supported. Restrictions on what a consumer may start are
  exactly the kind of thing that would later force a daemon change.
