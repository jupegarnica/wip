# Future improvements

Capabilities still pending in wip, ordered from most to least useful.

## wip prune

Prunes the folder of an archived item (or of all of them with `--archived`): removes `node_modules`, builds, binaries, browser profiles, caches and unreferenced `tmp/` content, with `--dry-run`, `--keep`, `--purge` and a `prune.md` report.
Today `archive` does not touch the disk and `.wip/items/` only grows. A generic version would let each project or flow declare prune rules (globs to delete and to keep, "stay if a `.md` of the item links it"), use the trash or a hard delete depending on the platform, and offer an optional `wip archive --prune`.

## wip unarchive

Reopens an archived item at a given phase with `--phase --reason [--wait] [--next]` and records the event in its history.
Today an archived item cannot come back: you have to create a new ID and lose the traceability. It is needed for "it turns out it was not finished" without editing the database by hand.

## Backlog with reminders

A `backlog` phase with `remind` (`next-session`, a date or `when-related`) parks an item until it is due, and the coordinator brings it up when the session starts (a `reminded` event, shown in "Your turn").
A generic version adds `park: {phase, field}` to the flow block, and `wip state` hides parked items until their date and lists them under `--attention` when they are due.

## wip hold

A generic "snooze": `wip hold <ID> --until <ISO|+Nh>` takes an item out of "Your turn" until a given time, and `check` warns when the hold expires. `--clear` lifts it earlier.

## wip round

Opens another round (QA, review) on the same item: an iteration counter, a `round<n>.` prefix on artifacts and a way back to an earlier phase without `--force`.
Today wip only goes back with `next` or `--force` and does not know how many iterations an item has gone through. A per-item iteration counter with its own event is useful in any `execute` → `check` loop.

## wip backup

Keeps rotated copies of the database. Today nothing protects `.wip/` from a corrupted or deleted database.
`wip backup` takes a consistent SQLite copy (`VACUUM INTO`) into `.wip/backups/db/` with configurable rotation, and could run automatically on `session start`.

## wip doctor

A single command that checks runtime, database, flows and `tmp/`.
Today that is split between `check` and `flow lint`. `doctor` would report whether the binary, the schema version, the `.wip/` root, the definitions folder and `wip web` are healthy, with an exit code for scripts and support.

## wip export

`wip export --json [--since ISO]` dumps a snapshot of items, events and runs.
Today there are only `state` and `show` per item. An `export` (JSON or NDJSON, with `--since`) is the basis for reports, external integrations, readable copies and migrations without reading the database directly.

## Period reports (dashboard and daily)

Reports such as "Your turn", a kanban per flow, an item table with cost, and "what moved yesterday and what is next today".
Today there is only the live web view. A generic version is `wip report --since <ISO|yesterday> [--format md|json]` with moved items, closed gates, runs and durations, with no agenda or email.

## Run metrics

Optional per-run fields (`--tokens`, `--cost`, `--model`, `--tests`) that the runtime passes in and that `show`, the web and the reports add up per item and per flow, plus `--duration`/`--duration-ms` on `agent stop`.
Today wip only stores state, wall-clock duration and a summary.

## wip msg

The CLI renders the coordinator's messages: levels with header and icon, line limits, `--body-file`, `--plain`, paths as `file://`, links from `links`, and `--msg-level` on `phase`, `agent stop` and `gate` to change state and message in one step (`wip gc` cleans up temporary bodies).
Today the format is just a rule in the skill and each model follows it in its own way. A `wip msg` would reduce tokens and produce identical messages in any runtime.

## Gate block validation

`gate open` refuses to open if the decision block lacks the minimum (summary, doubts, "if you approve", question) and the sections each phase type requires.
Today a gate only stores the question. A generic version adds an optional `gate_sections` to the flow phase and validates `--detail` against it, so no gate reaches the user without what they need to decide.

## wip lock

`wip lock acquire|release|ls` reserves a shared resource (a QA environment, a port, a test slot) with an owner, exits with code 5 if it is taken, and supports `--force --reason`.
It becomes necessary as soon as two parallel items compete for something: named locks with owner and expiry, visible in `state` and in the web.

## Rules from external state

A field with an external state (for example a pull request: approved, changes requested, merged) that a poller or the user updates, plus rules in the flow that propose a phase or a wait depending on its value, with a history of states.

## Linked items

`wip link <A> <B> --kind blocks|parent|related` relates items (for example stacked PRs, to propagate changes), shows the relations in `state` and in the web, and keeps a blocked item out of "Your turn".
Today items have no relations between them.

## Live agents (check --live)

`wip check --live h1,h2` compares the runs in progress with the handles the runtime still has alive, and marks the ones that are gone as orphans.
Today `--handle` is stored but nobody compares it: a lost run only shows up when another session starts.

## Visible progress

`wip progress <ID> "<step>"` (or a heartbeat per run) that the web shows and `check` uses to warn about silent runs, for example more than 10 minutes without a step.
It also lets the coordinator answer "how is it going?" without interrupting the subagent.

## Artifact versions

What is approved at a gate or published is written as `v<N>.<name>` and the gate approves an exact version.
Today `plan.md` is overwritten and the gate does not say which version was approved. A generic version is a `v<N>` convention in the subagent protocol, the exact path stored in the gate, and a diff between versions in the web.

## Kanban in the terminal

`wip state --line` (or `wip kanban --json`) prints a one-line kanban meant for shell status lines, tmux or any TUI, without depending on a specific runtime.
Today there is only the web.

## Claude Code hooks

Optional hooks that install into `.claude/settings.json` where Claude Code allows it: register every launched subagent automatically (`agent start`), stop the coordinator from asking without an open gate, and review the messages at the end of each turn.
Today wip only creates the definitions for Claude Code, and the core must never depend on these hooks.

## Authorizations for irreversible operations

`wip approve <ID> --op <op> [--expires]` grants a subagent permission for specific operations (quota, expiry, revocation), and a query `wip approved <ID> <op>` lets any agent or hook check it before running.
Today the only control is the proposal → gate → `APPROVED` pattern in the prompt.

## Continuous fleet improvement

An optional `improve` flow that collects the user's literal feedback, proposes changes to flows, agents and skills in batches, and validates them with `flow lint` before activating them. A `session-retro` agent could summarize each session.
Today definitions only change on request.

## Notifications

A configurable `notify` command in `.wip/config.json` that the CLI runs when a gate opens or an item moves to `waiting_on: user`.
Today wip does not notify.

## Configurable language

The language in the config, applied to the coordinator skill, the web and the help (`--lang`).
Today wip has a single language.

## wip import and migration

A generic importer (from another instance's `export` or from an earlier layout of the state) moves items, events and runs from one project to another, with `--dry-run`, `--verify` and `--snapshot`.

## --db and multiple roots

A read-only `--db` on `state`, `show` and `web` to inspect another database (copies, backups, another machine) and to see several projects.
Today wip only uses the nearest `.wip/` or `WIP_HOME`.

## wip web over the network with authentication

`wip web` listens on the LAN without authentication (or only locally with `--local`); authentication and multi-user use are out of scope for now.
It needs a token or password for LAN mode, and possibly several projects in one web instance.

## Distribution after the first release

The npm package runs on Node and is the only thing CI builds and publishes (see `docs/releasing.md`); the standalone
binaries are built locally with `bun scripts/build.ts --targets …`. Pending:

- **Binaries in the release.** `scripts/build.ts --targets` already compiles, signs ad hoc on macOS and archives the
  five binaries with `SHA256SUMS`, and its unit tests and `test/e2e/pack.test.ts` cover it. To ship them again,
  `release.yml` needs: a `binaries` job (ubuntu builds `linux-x64,linux-arm64,windows-x64`, macos builds
  `darwin-arm64,darwin-x64` and checks `codesign -v`; both upload `dist/release/*.tar.gz` and `*.zip`), a `smoke-bin`
  job per platform (unpack, then `--version`, `init`, `check` and `web` `/health` with neither Node nor Bun on
  `PATH`), `smoke-bin` in the `needs` of `publish`, and `github-release` downloading the archives, writing
  `SHA256SUMS` and passing them to `gh release create`. Before that: `ubuntu-24.04-arm` is free only for public
  repositories, `unzip` on the Windows runner is unconfirmed (`7z x` works), and the README Install section would
  again point to the Release.
- **`@garndev/wip-bin`**, an opt-in npm package with the binary, for users who want npm without Node's startup cost.
  It brings back a launcher and five platform packages that must publish in order; only if someone asks.
- **Notarized macOS binaries**, once they are in the release, so a browser download opens without the quarantine
  step (needs an Apple Developer ID).
- **An install script** (`curl … | sh`), once the binaries are in the release, that picks the archive, checks
  `SHA256SUMS` and installs it.
- **Homebrew** formula or tap for the binary.
- **Raise the Node floor** to 24 in the first minor after Node 22's end of life (2027-04-30): `node:sqlite` is a
  release candidate there, so the bin no longer needs to hide its ExperimentalWarning.
- **`linux-x64-baseline`** binary for x64 CPUs without AVX2 (the npm package already runs there).
- **Windows**: `wip_bin` is not recorded behind npm's `.cmd` shim and Windows junctions are untested; it stays
  experimental.
