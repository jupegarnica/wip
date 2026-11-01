# Changelog

## 0.1.0 (unreleased)

First version.

- Per-project state in `.wip/` (SQLite) with items, flows, agent runs, gates, sessions and invariants, driven by
  `wip phase`, `set`, `wait`, `log`, `agent`, `gate`, `archive`, `session`, `show`, `state` and `check`.
- Flows as skills, `<defs>/skills/wip-flow-<name>/SKILL.md`, with a `wip-flow` block, `wip flow lint` (frontmatter
  included) and the last valid version kept when an edit breaks a flow.
- `wip init`: the coordinator `wip`, the generic agents `fast`, `efficient`, `thinker` and `wise`, the skills
  `wip-coordinate`, `wip-new-flow` (with a reference flow, `example.md`), `wip-new-agent` and
  `wip-subagent-protocol`, and the `tasks` flow (stages `preparation`: intake, research, plan · `execution`:
  execute, check · `review`: review, deliver, done), in `.agents/`; `--harness claude-code` writes them straight into
  `.claude/agents` and `.claude/skills`. `.wip/config.json` keeps the folder and every command reads it from there.
- Claude Code: `claude --agent wip` starts the coordinator through its `initialPrompt`; the generic agents preload
  `wip-subagent-protocol` with their `skills` key.
- `from_any: true` on a phase of the `wip-flow` block makes it reachable from any non-terminal phase with a plain
  `wip phase`, no `--force` and no recorded decision; the `tasks` flow uses it on `plan`.
- `color: "#RRGGBB"` at the top of the `wip-flow` block sets the tone of the flow's stage colours on the board and the
  history (blue when absent).
- Polling: a `polling` key in the `wip-flow` block (`{name, phases, agent, cadence}`, cadence `30m`, `1h`, `2d`)
  declares which agent checks which phases and how often; `wip poll due` tells any scheduler what is `DUE`,
  `OVERDUE` (unattended for more than 1.5 cadences), `OK` or `IDLE` (always exit 0, read `--json`), `wip poll record`
  logs a pass and `wip poll seen` remembers what a pass saw. wip has no cron of its own. `wip check` warns with
  `poll_overdue`. This adds schema 2 (`poll_runs`, `poll_run_items`, `poll_seen`): any command migrates a schema 1
  database, an older build then refuses it (exit 10), and `wip web` migrates it at start; restart a running
  `wip web` after upgrading.
- `bun run install:local` builds the host tarballs and installs them with npm into `dist/local` (or `--prefix <dir>`),
  without the registry and without touching the global npm.
- Model onboarding: `wip check` warns with `models_unset` until each generic agent and the coordinator have a `model:`.
- Guided onboarding: a flow's `seed` lists items `wip init` creates once (an existing or archived ID is never
  touched), with `files` copied from the flow's skill folder into the item's artifacts; the `tasks` flow seeds
  `onboarding` in `intake` with `guide.md`. The coordinator mentions it in one `What next?` suggestion and, when the
  user starts it, links the guide on the kanban, answers from it and closes it at a gate, in `done` and archived.
- `wip web`: a read-only kanban served from the binary, each stage in one blue that grows more transparent stage
  after stage (light and dark themes); `--open` opens the browser on it, `wip web status` lists this project's
  servers from its registry (`.wip/web/<port>.json`), `wip web stop` stops them and `wip web log` shows its log
  (`.wip/logs/web.log`). Without `--port` it reuses this project's running one or serves on the first free port from
  33333 to 33352.
- The coordinator brings up the kanban at the start of every session through `fast`, without waiting for it:
  `wip web status`, then `wip web --open` when this project has none running.
- One binary per platform (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `windows-x64`), packaged for npm
  as `@garndev/wip` plus one optional package per platform.
- `wip --version` prints the branch, short commit, `-dirty` mark and build date fixed by `scripts/build.ts`
  (`(source)` from source); `--json` returns them as `branch`, `commit`, `dirty`, `built_at` and `source`.
