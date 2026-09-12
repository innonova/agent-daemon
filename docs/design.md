# agent-daemon design

Status: implemented 2026-09-12; this document is kept in step with the code.

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

A session is one child process started from a profile. Its record:

```json
{
  "id": "1413ac7e-…",            // uuid, or the client-supplied id (^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$)
  "profile": "claude",
  "label": null,
  "command": "claude",
  "args": ["-p", "…"],           // as resolved at start
  "cwd": "/home/me/project",
  "env": {},                     // the overlay only, not the inherited environment
  "loginShell": false,
  "pid": 12345,                  // kept after exit for correlation; null if never spawned
  "state": "running",            // or "exited"
  "exitCode": null,
  "signal": null,
  "exitReason": null,            // "daemon-restart" or "spawn-error: …" when the exit was not the process' own
  "startedAt": 1757653200000,
  "exitedAt": null,
  "lastSeq": 42
}
```

A spawn failure (command not found, cwd missing) is not a request error:
the session is created, a stderr-style log record with the OS error is
written, and the session exits with `exitReason` `spawn-error: …`. The
client sees the same frames it would for any short-lived process.

Exited sessions are retained, with their logs, until a client removes them.
The daemon applies no retention policy; housekeeping is a client concern.

When the daemon starts, any session recorded as `running` in the state
directory is marked `exited` with reason `daemon-restart`, and its `lastSeq`
is recovered from the log itself (meta.json is not rewritten per record).
Its log stays, so a client can inspect it and start a fresh session with the
agent's own resume arguments if it wants to continue. A session directory
whose meta.json is unreadable is ignored but its id stays reserved.

A session is only reported as started once its directory, log and initial
record exist on disk (`storage-error` otherwise). Later disk failures never
take the session or the daemon down: a log write that fails is retried on
every following record, and the session emits a stderr-style record when
logging fails and again when it recovers, so clients know replay has a
hole. A meta.json write that fails is logged; the next state change retries.

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
Writes are synchronous and complete, so the file always matches the
sequence numbers handed out. An in-memory sparse index (one entry per 256
records) maps `seq` to byte offset so attaching near the tail of a large
log does not scan the whole file; for sessions restored from disk the index
is built on the first read.

## Websocket protocol

Endpoint: `ws://127.0.0.1:4267/`. TCP only, no unix socket, to keep client
configuration uniform. Host and port come from `AGENT_DAEMON_LISTEN`
(default `127.0.0.1:4267`). `GET /health` over HTTP returns 200 with
`{"status":"ok"}`.

The TypeScript types for every frame live in `src/gateway/protocol.ts`.

Every frame is a JSON object with a `type`. Client requests carry a `ref`
(any string the client chooses); the daemon's direct reply to a request
carries the same `ref`. Events that are not replies have no `ref`.

### Client → daemon

| type | fields | reply |
|---|---|---|
| `hello` | `protocol: 1` | `welcome { protocol, version, profiles[], sessions[] }`, or `error` `unsupported-protocol` |
| `profiles.list` | | `profiles { profiles[] }` |
| `profiles.reload` | | `profiles { profiles[] }`, plus `profiles.changed` event to all |
| `sessions.list` | | `sessions { sessions[] }` |
| `session.start` | `profile, args?, argsReplace?, cwd?, env?, label?, id?, attach?: bool, replay?` | `session.started { session }` |
| `session.attach` | `id, replay?: false \| true \| { fromSeq }` | replayed `session.output` frames, then `session.attached { session, lastSeq }`; `cancelled` if detached, re-attached or disconnected before replay finished |
| `session.detach` | `id` | `session.detached { id }` |
| `session.input` | `id, data` | `ok` once the bytes are in the pipe; `stdin-full` if the process has stopped reading; `stdin-error` if the pipe failed |
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
sessions. Attaching to a session the connection is already attached to is a
no-op unless replay is requested, in which case the attachment is redone
with replay.

`hello` is optional; the daemon answers any request on a fresh connection.

Frames that are not valid JSON, or have no string `type`, get an `error`
with code `malformed` (carrying the `ref` if one could be read). A `type`
the daemon does not know gets `error` `unknown-type`.

### Daemon → client

| type | fields |
|---|---|
| `session.output` | `id, seq, t, s, d` (same shape as the log record) |
| `session.exit` | `id, exitCode, signal, exitReason, exitedAt` |
| `session.changed` | `session` (state or metadata change) |
| `profiles.changed` | `profiles[]` |
| `error` | `ref?, id?, code, message` |
| `ok` | `ref` |

`session.changed`, `session.exit` and `profiles.changed` go to every
connection, attached or not, so a client can keep a session list current
without attaching to everything. `session.output` goes only to attached
connections.

`session.removed { id }` is broadcast when a session is removed.

Error codes: `malformed`, `unknown-type`, `unsupported-protocol`,
`invalid-request` (a field has the wrong type; nothing was changed),
`unknown-profile`, `unknown-session`, `invalid-id`, `duplicate-id`,
`invalid-input`, `invalid-signal`, `session-not-running`, `session-running`,
`stdin-closed`, `stdin-full`, `stdin-error`, `storage-error`,
`replay-failed`, `cancelled`, `slow-consumer`, `internal`.

`session.input` replies `ok` only once the bytes have been handed to the
pipe. An agent that has stopped reading therefore delays the reply; a
client that awaits each reply is flow-controlled for free, and one that
does not is refused with `stdin-full` once the unwritten backlog exceeds
`AGENT_DAEMON_SLOW_CONSUMER_BYTES`. The `in` record is written before the
attempt; if the pipe then fails, an `err` record says so.

Replay: on attach with replay, the daemon reads the log from the requested
`seq` in rounds. Each round reads up to the session's `lastSeq` at the time
the round starts; when a round starts with nothing left to read, the
attachment switches to live in the same synchronous step, so no record is
skipped or duplicated and nothing is buffered in memory. Live output that
arrives during replay is simply picked up from disk by the next round.
`session.attached.lastSeq` is the last record delivered, or the session's
boundary when the requested cursor was beyond it. `seq` is contiguous, so a
client that reconnects asks for `{ fromSeq: lastSeen + 1 }` and misses
nothing.

Backpressure: every frame to a client goes through one path that checks
the socket's unsent bytes. Past `AGENT_DAEMON_SLOW_CONSUMER_BYTES` (default
64 MB) the client is not reading: it is detached from every session, sent
an `error` with code `slow-consumer`, and its connection is closed (code
1008), since even control frames could not reach it. The daemon never
blocks or buffers unboundedly on behalf of a client. During replay, which is
pull-based, the daemon instead pauses reading the log until the socket
drains. The log on disk remains authoritative and the client may reconnect
and reattach with replay.

## Process management

- Children are spawned with `stdio: ['pipe', 'pipe', 'pipe']` and
  `detached: false`. They are in the daemon's process group and die with it,
  which is the intended and accepted behaviour.
- stdout and stderr are split on `\n` and otherwise passed through
  byte-for-byte (a `\r` stays). A final partial line at exit is emitted as
  a line.
- The session exits when the child has exited *and* its stdout and stderr
  have closed, so final output is never lost. If a descendant inherited the
  pipes and keeps them open, they are closed `AGENT_DAEMON_PIPE_GRACE_MS`
  (default 10 s) after the child's exit and the session exits then.
- A single line is limited to 10 MB (`AGENT_DAEMON_MAX_LINE`, bytes). This
  is purely a memory bound against a child that stops emitting newlines; it
  is not expected to trigger with real agents. When exceeded, the buffered
  bytes are discarded and an `err` record says so immediately
  (`agent-daemon: line on <stream> exceeds <n> bytes; dropping it`); when
  the line finally ends, or the stream does, a second record reports the
  total (`agent-daemon: dropped <n> bytes exceeding line limit on
  <stream>`), and reading continues from the next newline.
- No automatic restart of exited children. Resume is an agent feature the
  client drives through arguments.
- With `loginShell`, the command line is prefixed with `exec` so the shell
  replaces itself with the agent; signals and the exit status then refer to
  the agent, whatever shell is configured.
- On `SIGTERM`/`SIGINT` the daemon sends `SIGTERM` to every running child,
  waits up to 5 s, sends `SIGKILL` to whatever is left, records the exits,
  drops client connections and exits 0. A hard 15 s limit ends the process
  regardless. Children are in the daemon's process group but nothing else
  ties their lifetime to it: if the daemon is killed with `SIGKILL`, the
  systemd cgroup (the unit's default `KillMode=control-group`) is what ends
  them. Outside systemd, orphans are possible after a hard kill.
- `SIGHUP` only reloads profiles. Nest's own shutdown hooks are deliberately
  not enabled, because they would treat `SIGHUP` as a shutdown.
- Uncaught exceptions and unhandled rejections are logged and the process
  carries on. A bug in one request must not end every session on the
  machine.

## Configuration

All configuration is by environment variable; there is no config file.

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_DAEMON_LISTEN` | `127.0.0.1:4267` | `host:port` to bind |
| `AGENT_DAEMON_CONFIG_DIR` | `$XDG_CONFIG_HOME/agent-daemon` (`~/.config/agent-daemon`) | holds `profiles/` |
| `AGENT_DAEMON_STATE_DIR` | `$XDG_STATE_HOME/agent-daemon` (`~/.local/state/agent-daemon`) | holds `sessions/` |
| `AGENT_DAEMON_MAX_LINE` | `10485760` | per-line byte limit |
| `AGENT_DAEMON_SLOW_CONSUMER_BYTES` | `67108864` | unsent bytes before a client is dropped; also the stdin backlog limit |
| `AGENT_DAEMON_PIPE_GRACE_MS` | `10000` | how long inherited pipes may stay open after the child exits |

`AGENT_DAEMON_LISTEN` may name a non-loopback address. The daemon does not
stop you; binding elsewhere than loopback is the operator's decision and
exposes an unauthenticated interface, which is outside this design.

## Testing

- `npm test`: unit tests for the line splitter, log, profile parsing and
  config.
- `npm run test:e2e`: builds, then boots the daemon in-process on an
  ephemeral port with temporary directories and drives every protocol frame
  against a fake agent (`test/fixtures/fake-agent.mjs`) that can echo, write
  stderr, emit oversized and partial lines, stop reading stdin, leave an
  orphan holding its pipes, trap signals and exit on command. Covers replay
  catch-up under load, cancellation, slow consumers, stale sequence
  recovery and restart marking. `test/process.e2e-spec.ts` runs the built
  `dist/main.js` as a real process and checks `SIGHUP` reload and `SIGTERM`
  shutdown.
- `npm run smoke:agents [claude|codex|copilot]`: opt-in, costs tokens, runs
  one real turn through each installed agent CLI and checks the answer.

## Running it

Intended as a systemd **user** service, because the agents' credentials and
config live in the user's home directory.

```
npm run install:service
```

`scripts/install-user-service.sh` builds, copies a production install to
`~/.local/lib/agent-daemon`, writes default `claude`, `codex` and `copilot`
profiles if none exist, enables lingering so the service outlives login
sessions, and installs and starts the unit from
`systemd/agent-daemon.service`. The unit bakes in the `PATH` of the shell
that ran the script so the agent CLIs are found, and unsets
`ELECTRON_RUN_AS_NODE` so an IDE-descended environment cannot turn
Electron-based tools into plain node.

```
systemctl --user reload agent-daemon    # re-read profiles (SIGHUP)
journalctl --user -u agent-daemon -f    # logs
```

Re-running the install script restarts the service, which ends every
running session. That is the one operation this daemon is designed to
make rare.

## Out of scope

Authentication, TLS, remote access, one-shot command execution, filesystem
browsing, session retention policies, PTY sessions, any parsing of agent
output. These belong to the services and UIs built on top.

## Resolved questions

- Port 4267, TCP on loopback. No unix socket: TCP is uniform for every
  client and causes less confusion.
- 10 MB per-line limit as a crash guard only.
- `pid` stays in the record after exit (the draft said null): it is useful
  for correlating with system logs and costs nothing.
- `argsReplace` is supported. Restrictions on what a consumer may start are
  exactly the kind of thing that would later force a daemon change.
