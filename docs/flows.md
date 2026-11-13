# Flows

[← Back to the README](../README.md)

A flow is one skill, `<defs>/skills/wip-flow-<name>/SKILL.md`: the folder's suffix is the flow's name, and its
frontmatter carries `name: wip-flow-<name>` and a `description` that says which items it is for. Its `wip-flow`
block is the only source of its phases:

```wip-flow
version: 1
fields:
  title: string
phases:
  - name: intake
    gate: none
    next: [review]
    waiting_default: user
  - name: review
    gate: ask
    next: [fix, done]
    agent: thinker
    writes: artifacts
  - name: fix
    gate: auto
    next: [review]
    agent: efficient
    writes: project
  - name: done
    kind: terminal
```

The text around the block (`## Subagents`, one `### <phase>` per phase) tells the coordinator what each phase does.
The reference of every key (`id_pattern`, `fields` and their types, `links`, `seed` and its `files`, `stage`, `gate`,
`waiting_default`, `agent`, `writes`, `from_any`, `polling`) is in `<defs>/skills/wip-new-flow/SKILL.md`, and `wip-new-flow/example.md` is a complete flow
to copy from (it is not a flow itself: only folders named `wip-flow-*` are).
Each `agent:` names one of the generics in [The four generic agents and their models](agents-and-models.md).

`wip init` ships four flows, all written by default: `development` (a piece of work in a worktree and branch, from
the plan through the build, QA and review to the commit and the release), `ideas` (shape an idea before building),
`reports` (a search or a report, one-off or recurring) and `tasks` (a task with a clear outcome). The wizard's Flows
step chooses them; `--flows <names>` picks a subset for scripts (see [Start a project: `wip init`](init.md)).

The `tasks` flow is generic: the same phases carry code, an investigation, a document or a decision, one-off or
recurring.

| Phase    | What happens                                                                    |
| -------- | ------------------------------------------------------------------------------- |
| `todo`   | the request and the plan, which you approve; a recurring task waits here        |
| `doing`  | the deliverable and its check against the plan's criteria                       |
| `done`   | your review of the run; a recurring task waits here when `after_review` says so |
| `closed` | the item ends here and is archived                                              |

A request that needs no work, or that you drop, goes from `todo` straight to `closed`; `todo` is reachable from any
phase (`from_any: true`), so a wrong approach goes back to the plan and its gate without `--force`.

A recurring task also carries `schedule` (a cron expression in local time), `next_run` (the next run) and
`after_review` (`todo` or `done`, where it waits between runs).

To create a flow, ask the coordinator («create a flow for reviews with these phases…»): it follows `wip-new-flow`
(proposal, your approval, backup, write, `wip flow lint`, restore if the lint fails). By hand:

```sh
mkdir .claude/skills/wip-flow-review
cp .claude/skills/wip-new-flow/example.md .claude/skills/wip-flow-review/SKILL.md   # then edit it
wip flow lint review                               # exit 0, or one line per problem and exit 1
wip phase R1 intake --flow review
wip state --flow review
```

`wip flow lint` checks the frontmatter (`name` equal to the folder, a `description`), the block's schema, that
every phase is reachable through `next` or `from_any`, one or more terminal phases and that each other phase can reach one of them, `next` targets, `waiting_default`, `links` patterns, that each `agent:`
exists in `<defs>/agents/` with a `name` and a `description`, that `writes` is `artifacts` or `project`, that each `polling` entry names an existing phase and agent and has a valid
cadence, and that no live item sits in a phase the file removes.
Each valid version is stored when a command loads it: if a later edit breaks the file, `flow lint` fails, and every
other command keeps using the last valid version with a `flow_invalid` warning until the file is fixed.

`wip flow disable <flow>` switches a flow off in this copy of the project (a flag in `.wip/wip.sqlite`, no file
changes): its items leave `wip state`, `wip check`, the polls and the board, and every write on them exits 3.
`wip show <ID>` still shows them with a `flow_disabled` warning. `wip flow enable <flow>` brings it back; `wip flow lint` lists the disabled flows.

Flows are not fixed. Ask the coordinator to edit a flow or an agent, to disable one you do not use, or to create a
new one: it proposes the change and waits for your approval, a subagent then writes it with a backup under
`.wip/backups/defs/` and runs `wip flow lint` (see `wip-new-flow` and `wip-new-agent`). The onboarding guide's
«Your own flows and agents» says it, and the coordinator adds one line about it at the start of a session while the
seeded `onboarding` item is not started (see [Coordinating](coordinating.md)); a project initialised without `tasks`
has no such item and no such line.

## The order of the flows on the board

Both `wip web` and the Kanban mod list the flows in the project's order, kept as `flow_order` in
`.wip/config.json`:

```json
{ "defs_dir": ".claude", "flow_order": ["tasks", "development"] }
```

`wip flow order tasks development` sets it, first = first on the board; `wip flow order` prints it, and
`wip flow order --reset` removes the key, back to alphabetical. Every flow the list does not name comes after the
named ones, alphabetically. A name that is not a flow is ignored, and `wip flow order` warns about it. A disabled
flow keeps its place while it is off. A malformed `flow_order` never blocks a command: it warns
(`flow_order_invalid`) and leaves the board alphabetical until it is fixed or reset.

The commands are in [Commands](commands.md); `wip init` writes the four shipped flows and `--flows` selects a
subset, as described in [Start a project: `wip init`](init.md). A project initialised without `tasks` has no
`onboarding` item and no onboarding line at the start of a session.
