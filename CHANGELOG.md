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
- Model onboarding: `wip check` warns with `models_unset` until each generic agent and the coordinator have a `model:`.
- Guided onboarding: a flow's `seed` lists items `wip init` creates once (an existing or archived ID is never
  touched), with `files` copied from the flow's skill folder into the item's artifacts; the `tasks` flow seeds
  `onboarding` in `intake` with `guide.md`. The coordinator mentions it in one `What next?` suggestion and, when the
  user starts it, links the guide on the kanban, answers from it and closes it at a gate, in `done` and archived.
- `wip web`: a read-only kanban served from the binary, each stage in one blue that grows more transparent stage
  after stage (light and dark themes); `--open` opens the browser on it, `wip web status` says
  whether this project's one is up, `wip web stop` stops it and `wip web log` shows its log (`.wip/logs/web.log`).
- The coordinator brings up the kanban at the start of every session through `fast`, without waiting for it: it
  reuses this project's `wip web` or starts one on the first free port from 39100 to 39109.
- One binary per platform (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `windows-x64`), packaged for npm
  as `@garndev/wip` plus one optional package per platform.
