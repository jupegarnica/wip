# The four generic agents and their models

[← Back to the README](../README.md)

`fast`, `efficient`, `thinker` and `wise` share one contract and one body; they differ only in a paragraph about
level, from cheapest to most capable:

- `fast` does exactly what it is told and returns `needs-input` when the task needs a decision;
- `efficient` carries out clear tasks end to end with bounded exploration;
- `thinker` investigates, compares alternatives and justifies its decisions;
- `wise` questions assumptions, looks for risks and edge cases, and is never a default.

Each phase of a [flow](flows.md) names its default agent (`agent:`) and what its subagent may write
(`writes: artifacts` or `project`). The coordinator may pick a cheaper or a more capable generic for a given task, and
steps up one level after a failure.

The model of each generic agent and of the coordinator (marked `wip: coordinator`) is its `model:` frontmatter line,
and each template under `templates/agents/` carries one: `haiku` (`fast`), `sonnet` (`efficient`), `opus` (`thinker`),
`fable` (`wise`) and `inherit` (the coordinator). `wip init` writes the template as it is and never asks for or
writes a model; `wip init --yes` fills no `model:` either and takes the default of each wizard step, the Kanban one
included (see [The Kanban mod](init.md#the-kanban-mod---kanban)). In a terminal `wip init` asks in five steps: the scope
(`local`, the default, in the project, or `global`, in your home folder like `--global`; `--global` skips it and an
initialised project keeps its scope, shown as `scope kept`), the flows to write (all four checked, Space toggles,
`--flows` skips it), the `wip start` command, what goes into `.gitignore` and the Kanban mod (`yes`, the default, or
`no`), shows a summary and writes nothing until you confirm (Enter takes the
default, Ctrl+C writes nothing). Colours appear only on a terminal without `NO_COLOR`. `--start '<command>'`,
`--start-default` and `--no-start` answer that one question each. Without a terminal (scripts, CI) init asks nothing
and only `start` can stay unset, as before: `wip check` then reports `start_unset` (exit code unchanged) and the
coordinator mentions it once. A definition edited by hand without a `model:` line is reported by `wip check` as
`models_unset`, and the runtime default model applies meanwhile. Re-running `wip init` never overwrites a saved
`start` unless you answer so, and `--force` keeps the `model:` line a file already had. The definitions folder is
versioned with the project when it is local, so whoever clones the project keeps the models. For a `--global` project
the definitions and the models live in your home folder: they are shared by every `--global` project on your machine,
and a clone on another machine has to run `wip init` again. To change a model later, edit the `model:` line in
`<defs>/agents/<name>.md`: the coordinator does it with a backup in `.wip/backups/defs/agents/` and checks the diff,
the flow lint and `wip check`, or you edit the line by hand.

What happens with `model:` in Claude Code:

- It reads it from `.claude/agents/`. It accepts an alias (`haiku`, `sonnet`, `opus`, `fable`), `inherit`
  or a full model ID. For a generic agent, `inherit` is the coordinator's model; for the coordinator, it is the model
  `claude` is started with. `claude --agent wip` reads the coordinator's `model:` when it starts, so a change to it
  needs a restart. If the running session does not pick up a generic's change, open `/agents` or restart it.

The commands named here are in [Commands](commands.md); the start command is in
[Start the coordinator: `wip start`](start.md).
