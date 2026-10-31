# Changelog

## 0.1.0 (unreleased)

First version.

- Per-project state in `.wip/` (SQLite) with items, flows, agent runs, gates, sessions and invariants, driven by
  `wip phase`, `set`, `wait`, `log`, `agent`, `gate`, `archive`, `session`, `show`, `state` and `check`.
- Flows in `.agents/flows/<name>.md` with a `wip-flow` block, `wip flow lint` and the last valid version kept when an
  edit breaks a flow.
- `wip init`: the coordinator, the generic agents `fast`, `efficient`, `thinker` and `wise`, the skills
  `wip-coordinate`, `wip-new-flow` and `wip-new-agent`, the subagent rules and the `wip` flow; `--runtime claude-code`
  links `.claude/agents` and `.claude/skills`.
- Model onboarding: `wip check` warns with `models_unset` until each generic agent has a `model:`.
- `wip web`: a read-only kanban served from the binary.
- One binary per platform (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `windows-x64`), packaged for npm
  as `@garndev/wip` plus one optional package per platform.
