# Writing a client

This is the daemon's protocol from the client's side. The normative
description is in [design.md](design.md); this page shows the frames in the
order you will actually send them, with a real Claude Code session as the
example. Everything here was exercised by `scripts/smoke-agents.mjs`, which
is the smallest complete client in the repository.

## The shape of things

- One websocket per client, `ws://127.0.0.1:4267/`. Every frame is a JSON
  object with a `type`. Put a `ref` of your choosing on each request; the
  reply carries the same `ref`. Events that are not replies have no `ref`.
- A **profile** is a template on disk (command, base args, cwd, env). A
  **session** is a running process started from one. You may start as many
  sessions from a profile as you like.
- The daemon forwards **lines**. What you send as `data` becomes one line on
  the agent's stdin; every line the agent writes comes back as a
  `session.output` frame with a per-session sequence number `seq`. The
  daemon never looks inside the lines. Knowing what a Claude, Codex or
  Copilot line means is your job.
- Every line, in both directions, is appended to a log on disk. Attaching
  with replay streams that log back with the same `seq` values, then
  continues live without a gap. That is what lets you rebuild the UI while
  the agent keeps working.

## A complete Claude Code session

The default `claude` profile runs
`claude -p --input-format stream-json --output-format stream-json --verbose
--include-partial-messages --replay-user-messages`: one long-lived process
that takes user turns as JSON lines on stdin and streams events as JSON
lines on stdout.

### 1. Connect and say hello (optional)

```json
{"type":"hello","ref":1,"protocol":1}
```

```json
{"type":"welcome","ref":1,"protocol":1,"version":"0.0.1",
 "profiles":[{"name":"claude","command":"claude","args":["-p","..."],"cwd":null,"env":{},"loginShell":false}, ...],
 "sessions":[ ...every session the daemon knows, running or exited... ]}
```

`hello` is optional; any request works on a fresh connection. It is the
cheap way to get the profile and session lists in one go.

### 2. Start a session and attach to it

```json
{"type":"session.start","ref":2,"profile":"claude",
 "cwd":"/home/me/project",
 "args":["--permission-mode","acceptEdits","--model","claude-haiku-4-5-20251001"],
 "label":"fix the login bug",
 "attach":true}
```

`args` are appended to the profile's base args. `cwd`, `env` and `label`
are optional. `attach: true` attaches this connection before the reply so
you cannot miss the first line.

```json
{"type":"session.started","ref":2,"attached":true,
 "session":{"id":"1413ac7e-…","profile":"claude","state":"running","pid":12345,
            "args":["-p","...","--permission-mode","acceptEdits","..."],"cwd":"/home/me/project",
            "startedAt":1757653200000,"lastSeq":0, ...}}
```

Every other connection receives `session.changed` with the same record.

### 3. Send a turn

```json
{"type":"session.input","ref":3,"id":"1413ac7e-…",
 "data":{"type":"user","message":{"role":"user","content":"Reply with exactly the word PONG and nothing else."}}}
```

`data` may be an object (the daemon serialises it) or a string (written
verbatim). Either way it becomes one line plus `\n`.

The reply `{"type":"ok","ref":3}` arrives once the bytes are in the pipe.
If the agent has stopped reading its stdin, the reply is delayed; if you
keep sending anyway, you eventually get `error` `stdin-full`. Awaiting each
`ok` before sending the next line is the simplest correct behaviour.

### 4. Read the output

The daemon now streams one frame per line the agent writes:

```json
{"type":"session.output","id":"1413ac7e-…","seq":1,"t":1757653200123,"s":"in",
 "d":"{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"Reply with…\"}}"}
{"type":"session.output","id":"1413ac7e-…","seq":2,"t":1757653200456,"s":"out",
 "d":"{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"9ec1f428-…\",\"cwd\":\"/home/me/project\",\"tools\":[…]}"}
{"type":"session.output","id":"1413ac7e-…","seq":3,"t":…,"s":"out","d":"{\"type\":\"assistant\",\"message\":{…\"content\":[{\"type\":\"text\",\"text\":\"PONG\"}]…}}"}
{"type":"session.output","id":"1413ac7e-…","seq":4,"t":…,"s":"out","d":"{\"type\":\"result\",\"session_id\":\"9ec1f428-…\",\"total_cost_usd\":0.0699,…}"}
```

- `s` is `in` (a line you sent), `out` (agent stdout) or `err` (agent
  stderr, and the daemon's own notices, which always start with
  `agent-daemon:`).
- `d` is the raw line. For `in` and `out` it is JSON by contract with the
  agent, but parse it yourself; the daemon does not.
- `seq` is contiguous per session across all three streams. Remember the
  last one you saw.

What the lines mean is Claude Code's stream-json protocol, not the
daemon's. The pieces you will care about first: the `system`/`init` event
carries Claude's own `session_id` (keep it if you want `--resume` later),
`assistant` events carry the content blocks, `result` ends a turn, and with
`--include-partial-messages` you also get `stream_event` deltas for
token-level rendering. Permission prompts arrive as `control_request`
lines and are answered with a `control_response` line through
`session.input`, exactly like a turn. See the Claude Code headless
documentation for the current shapes.

### 5. Continue, or end

Send the next turn as in step 3; the same process answers with its context
intact. To end the session cleanly, close stdin:

```json
{"type":"session.end-input","ref":4,"id":"1413ac7e-…"}
```

Claude exits with code 0 and everyone receives:

```json
{"type":"session.exit","id":"1413ac7e-…","exitCode":0,"signal":null,"exitReason":null,"exitedAt":…}
{"type":"session.changed","session":{"id":"1413ac7e-…","state":"exited","exitCode":0,…}}
```

`session.signal` with `SIGINT`, `SIGTERM` or `SIGKILL` is the impolite
alternative. An exited session, with its log, stays until someone sends
`session.remove`.

## Rebuilding the UI while the agent works

This is the case the daemon exists for. Your process restarts; the agent
does not notice. On the new connection:

```json
{"type":"sessions.list","ref":1}
```

pick the session, then

```json
{"type":"session.attach","ref":2,"id":"1413ac7e-…","replay":true}
```

The daemon streams the whole log as `session.output` frames, `seq` 1
onwards, then replies

```json
{"type":"session.attached","ref":2,"lastSeq":57,"session":{…}}
```

and from there you receive live frames with `seq` 58, 59, … There is no
gap and no duplicate: the daemon reads the log in rounds until it has
caught up, then flips to live in the same step.

If you kept the last `seq` you saw, ask for only what you missed:

```json
{"type":"session.attach","ref":2,"id":"1413ac7e-…","replay":{"fromSeq":58}}
```

Attaching without `replay` gives live output only. Attaching to an exited
session replays its log and then simply has nothing more to send.

## Things worth knowing

- **Several clients can attach to one session.** All of them receive its
  output; any of them (attached or not) may send input. Closing a
  connection detaches it and affects nothing else.
- **`session.changed`, `session.exit`, `session.removed` and
  `profiles.changed` go to every connection**, attached or not, so a
  session list can stay current without attaching to everything.
- **Read fast.** A client with more than 64 MB unsent is not reading; the
  daemon sends `error` `slow-consumer`, drops its attachments and closes the
  connection. Reconnect and attach with `replay: {fromSeq}`.
- **Resume is the agent's feature, not the daemon's.** If a session has
  exited (including after a daemon restart, which marks it
  `exitReason: "daemon-restart"`), start a new one with the agent's own
  resume arguments, for example `"args": ["--resume", "<claude session_id>"]`.
  The old log stays readable.
- **`argsReplace`** replaces the profile's base args entirely instead of
  appending, if you need to run the command some other way. The daemon
  does not judge the result.
- **Errors** are `{"type":"error","ref":…,"code":…,"message":…}`. Codes
  are listed in [design.md](design.md#websocket-protocol). `invalid-request`
  means a field had the wrong type and nothing was changed.

## The other agents

The same client code drives Codex and Copilot; only the lines differ.

- **Codex**: profile `codex` runs `codex app-server`, JSON-RPC over stdio.
  Send `initialize`, then the `initialized` notification, then
  `thread/start` and `turn/start`; output arrives as `item/*` and `turn/*`
  notifications.
- **Copilot CLI**: profile `copilot` runs `copilot --acp`, the Agent Client
  Protocol, also JSON-RPC over stdio. Send `initialize`, `session/new`,
  then `session/prompt`; output arrives as `session/update` notifications.

`scripts/smoke-agents.mjs` contains a working minimal exchange for all
three and is the quickest way to see the exact lines.
