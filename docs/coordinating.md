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
only when the start fails. When the watcher sees the `wip web` process gone, it starts it again, waits for
`wip web status` and gives you the new URL; if it does not come back, it tells you and leaves it to you.

While the seeded `onboarding` item is open and still not started, the closing message of every session also says in
one line that the flows and agents are yours to change — edit one, disable one you do not use, or create a new flow
or agent by asking — with «Your own flows and agents» in the guide as the detail. The line stops being added once
the onboarding starts, and a project initialised without `tasks` has no onboarding item and no line. The commands
are in [Flows](flows.md).

The subagents it launches are in [The four generic agents and their models](agents-and-models.md), and the phases and
gates it follows are in [Flows](flows.md).
