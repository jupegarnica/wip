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

The default flow, `tasks`, is generic: the same phases carry code, an investigation, a document or a decision,
grouped in three stages.

| Stage         | Phases                         | What happens                                                                                                                               |
| ------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `preparation` | `intake` → `research` → `plan` | the request; context, sources and options (skipped when clear); a plan that fixes what is delivered and how it is checked, approved by you |
| `execution`   | `execute` → `check`            | the deliverable; its check against the plan's criteria, back to `execute` when red                                                         |
| `review`      | `review` → `deliver` → `done`  | you validate the result; `deliver` only when something is written outside the project (a pull request, a message, a ticket)                |

A request that needs no work, or that you drop, goes from `intake` straight to `done`. `plan` is reachable from any
phase (`from_any: true`): a wrong approach goes back to it, and its gate, without `--force`.

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

The commands are in [Commands](commands.md); `wip init` writes the shipped `tasks` flow, as described in
[Start a project: `wip init`](init.md).
