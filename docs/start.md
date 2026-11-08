# Start the coordinator: `wip start`

[← Back to the README](../README.md)

A project needs its definitions first: see [Start a project: `wip init`](init.md).

`wip start` runs, from the project root and in the foreground, the start command saved in `.wip/config.json`: by
default `claude --agent wip --name wip-<stamp>`, which starts the coordinator. Bare `wip` does the same
in a terminal when a project and a command are there; otherwise it prints the help, as `wip help` and `wip --help` do.
`wip start --set -- <command> <arg> …` saves another command (variables `{stamp}`, `{project}`, `{root}`, `{defs}`),
`wip start --dry-run` shows the expanded command and `wip start --unset` goes back to the default.
`wip start` also records in `.wip/config.json` (`wip_bin`) the path it was started as, such as `wip2` from a dev build,
replacing a different value and printing one stderr line; so the coordinator and its subagents run that same binary.
The launched session gets `WIP_BIN` with that path; the coordinator runs it as `wip`.

Claude Code reads agents from `.claude/agents/` and skills from `.claude/skills/`, so the definitions work there
directly, next to other tools' agents and skills; a name clash with a file without the `wip:` mark is exit 3. The
coordinator's `initialPrompt` is the session's first message, so it runs its start protocol at once. The
generic agents preload the protocol skill through their `skills` frontmatter key.

The coordinator's behaviour in a session is in [Coordinating with Claude Code](coordinating.md); the agents it
launches are in [The four generic agents and their models](agents-and-models.md).
