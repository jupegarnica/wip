# Coordinating with Claude Code

[← Back to the README](../README.md)

wip never calls Claude Code: the coordinator calls wip. The coordinator is the `wip` agent, which Claude Code loads
with the skill `wip-coordinate` from `<defs>/`; `wip start` launches it with the start command saved in
`.wip/config.json` (by default `claude --agent wip --name wip-{stamp}`), and bare `wip` does the same in a terminal.
See [Start the coordinator: `wip start`](start.md).

The **Runtime interface** section of `wip-coordinate` maps the protocol's capabilities to Claude Code's tools. On the
first message of every session, whatever it says (with Claude Code, the coordinator's own `initialPrompt`), the
coordinator starts with `wip session start`, `wip state --attention` and `wip check`, and never relaunches a run it
finds `orphaned`: it tells you. It also asks `fast`, in the background, to bring up the kanban: `wip web status` says
whether this project's `wip web` is up; if it is, no second one starts. Otherwise `fast` runs `wip web --open`, which
takes the first free port from 33333 and opens the browser. You get one line with the URL and the port, and a warning
only when the start fails. When a later `wip web status` finds the kanban down or its log with errors, the
coordinator tells you; it starts it again or stops it only when you ask.

The subagents it launches are in [The four generic agents and their models](agents-and-models.md), and the phases and
gates it follows are in [Flows](flows.md).
