# Reviewing changes

How this code was reviewed while it was built, kept here so the next round
of work can use the same loop without reinventing it.

## The loop

1. Build the change with tests.
2. Run `npm test`, `npm run test:e2e`, `npm run lint`, and, if the change
   touches how processes are spawned or lines are forwarded,
   `npm run smoke:agents` (costs tokens on three vendors).
3. Ask an independent model to review against the spec. Reviewers report;
   this side fixes. Reviewers never edit the tree.
4. Fix, extend `docs/design.md` if a decision changed, rerun step 2, and
   review again until a round comes back with nothing material.

Two reviewers were used, for different reasons:

- **Codex** (`codex exec -m gpt-6-astra --sandbox read-only`) with the deep
  prompt below. Its built-in `review` command is only a light pass; the
  custom prompt is what found the real bugs. It runs fault-injection probes
  in memory against the source, so its findings come with reproductions.
  Roughly fifteen minutes per round. Redirect stdin from `/dev/null` or it
  waits for input.
- **Claude Code** (`claude -p --allowedTools "Read,Glob,Grep"`) with the
  light prompt below, as the cheap second opinion between Codex rounds. It
  cannot run anything, so it reasons from the code; it caught ordering and
  timing bugs Codex had not.

What the rounds found on the first implementation, for calibration:
twenty-three findings (four critical), then twelve, six and three. The
critical ones were Nest's default shutdown hooks treating `SIGHUP` as a
shutdown, unbounded replay and stdin buffering, and broadcasts bypassing
the slow-consumer guard.

## Codex deep prompt

Run from the repository root:

```
codex exec -m gpt-6-astra --sandbox read-only -C "$PWD" -o review.md "$(cat prompt.md)" < /dev/null
```

with `prompt.md`:

```
You are reviewing a small NestJS daemon in this repository. Read
`docs/design.md` first: it is the specification and states the principles
the code must honour. Then read every file under `src/` and `test/` in
full. Do not skim.

Review deeply and adversarially, in this priority order:

1. Correctness bugs. Race conditions (especially replay-then-live attach in
   src/gateway/agent.gateway.ts, and process exit vs. stream end in
   src/sessions/session.ts), resource leaks (file descriptors, listeners,
   maps that grow), crash paths (unhandled promise rejections, exceptions
   thrown from event handlers or inside for-await), incorrect sequencing of
   seq, data loss, wrong behaviour when a websocket closes mid-operation,
   when a child dies mid-write, when stdin is closed, when the log file is
   huge. For each: give the concrete scenario that triggers it and the
   observable wrong result.
2. Conformance to docs/design.md. Anything the doc promises that the code
   does not do, or does differently. Anything the code does that the doc
   does not describe.
3. Violations of the principles. Any agent-specific logic, any restriction
   on what a client may start, any behaviour that would force the daemon to
   be restarted or redeployed when a client's needs change, any unnecessary
   dependency.
4. Test gaps. Behaviours in the spec not covered by the test suites, and
   tests that pass for the wrong reason.
5. Robustness under a daemon that runs for weeks: memory growth, fd
   exhaustion, timer leaks, log growth handling, anything that degrades
   over time.

Skip style, naming and formatting comments entirely. Skip anything you
cannot tie to a concrete failure or a concrete spec clause. Be strict about
severity: reserve major for something that loses data, wedges a session or
the daemon, or breaks the protocol contract for a well-behaved client.

Output a markdown report with one section per finding: a title, severity
(critical / major / minor), file and line, the scenario, the observable
effect, and a suggested fix. Order by severity. End with a short list of
things you checked and found correct. If you find nothing in a category,
say so explicitly.
```

For a follow-up round, add a numbered list of the previous findings and
what was done about each, and ask for a "Previous fixes verified" section
with OK / NOT OK per item. That is what turns a reviewer into a regression
check.

## Claude light prompt

```
claude -p --allowedTools "Read,Glob,Grep" --output-format text "<prompt>" < /dev/null
```

```
Read docs/design.md (the spec), then <the files that changed> in full. You
are a second-opinion reviewer. List only concrete correctness bugs, spec
deviations, or leak/crash paths you can tie to a specific scenario, with
file:line and the scenario. No style comments. If you find nothing in a
file, say so in one line. Be brief.
```

## What to feed the reviewer

Always the spec and the code, never a diff alone. Both reviewers found
their best bugs by comparing behaviour to a sentence in `docs/design.md`.
Keep the doc honest and the reviews stay useful.
