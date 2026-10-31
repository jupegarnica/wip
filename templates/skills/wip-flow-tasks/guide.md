---
wip: guide
---

# Get to know wip

This guide describes the defaults `wip init` writes. Your project may have changed its flows and agents since: the
source is always the definitions folder, `<defs>/` (`defs_dir` in `.wip/config.json`, `.agents/` by default).

## What wip is

- **The coordinator** is the only agent you talk to. It moves your work forward, records every step and asks you
  only for the decisions that are yours.
- **An item** is one unit of work with an ID: a task, an investigation, a document. This guide is the artifact of the
  item `onboarding`.
- **A flow** is the path an item follows: a list of **phases** grouped in **stages**. Each flow is a skill,
  `<defs>/skills/wip-flow-<flow>/SKILL.md`.
- **Subagents** do the work of each phase in the background, so the coordinator stays free to talk to you.
- **The state** (phase, who it waits on, the next step, runs, gates, timeline) lives in `.wip/` and only changes
  through the `wip` CLI. Nothing is kept in the coordinator's memory.

## This onboarding

`onboarding` is a real item of the `tasks` flow, in `intake`. Its steps show in its `next` on the kanban:

1. Read this guide and find the item on the kanban.
2. Ask the coordinator anything about it, or tell it you have read it.
3. Answer its gate «Close the onboarding?». Approve moves the item to `done` and archives it.

After that the coordinator suggests your first real task. The guide stays readable from the history of the kanban.

## How to ask for things

Write as you would to a colleague; there are no commands to learn:

- «Fix the failing login test», «Investigate why the build is slow», «Write a summary of the API changes».
- «What is waiting on me?» lists the items whose next step is yours, open gates first.
- «Status of <ID>» gives the phase, who it waits on, its runs and its artifacts.
- «Stop», «change the plan to …» or «use thinker for this» work in the middle of a phase: the coordinator stops or
  relaunches with your words, and records them.

## Flows and stages

The default flow, `tasks`, carries any task with a clear outcome:

- **preparation**
  - `intake`: the coordinator writes `request.md` with you and sets the title.
  - `research`: a subagent gathers context and options; skipped when the request is clear.
  - `plan`: a subagent writes `plan.md` with what is delivered and how it is checked; you approve it.
- **execution**
  - `execute`: a subagent produces the deliverable as the plan says.
  - `check`: a subagent checks it against the plan's criteria; red goes back to `execute`.
- **review**
  - `review`: you validate the result.
  - `deliver`: only when something goes outside the project (a pull request, a message, a ticket).
  - `done`: closed, then archived.

A typical task: you ask → `intake` → `research` if needed → `plan` (approved) → `execute` → `check` → `review` →
`deliver` if it goes outside → `done`.

## Agents and models

Four generic agents share one contract and differ in level and cost, from cheapest to most capable:

- `fast`: mechanical work with literal steps.
- `efficient`: carrying out a clear plan, a scoped change, a check against written criteria.
- `thinker`: anything that needs decisions: plans, investigations, design.
- `wise`: high ambiguity or risk, or after `thinker` failed on the same thing.

Each phase names its default agent. The coordinator picks a cheaper one when the work is mechanical and escalates one
level when a run fails for difficulty. On the first start it asks which model each one uses; ask it to change one at
any time.

## Gates

A gate is a decision of yours on one item: approving a plan, accepting a result, publishing something. The
coordinator shows a 🟧 block with the summary and what happens if you approve, then three options:

1. Approve
2. Change (say what)
3. Stop this item

Only an explicit answer of yours approves. Open gates also show on the kanban, at the top.

## Messages

| Icon | Type | Means |
|---|---|---|
| 🟦 | INFO | progress, a launch, an answer; every turn ends with `What next?` |
| 🟩 | DONE | a phase or a piece of work finished, with its time and runs |
| 🟨 | WARNING | an incident or a risk that does not block |
| 🟧 | gate | a decision of yours, as the last text of the turn |
| 🟥 | ACTION | something only you can do, or something blocks progress |

## The kanban

`wip web` serves a read-only kanban of this project. The coordinator brings it up at the start of each session and
gives you its address (`Local:`, by default `http://localhost:39100/`).

- **Boards:** one per flow, with a column per stage (Grouped) or per phase (Expanded).
- **✋ Open gates** and **👉 Your turn** at the top: what waits on you.
- **History:** every item, open and archived, with filters.
- **The panel of an item** (click its card): state, totals, links, artifacts, agents, gates and timeline. Each
  artifact opens in its own page, `/view/item/<flow>/<ID>/artifact/<name>`; this guide is
  `/view/item/tasks/onboarding/artifact/guide.md`.
- **Links into the kanban:** add `?item=<flow>/<ID>` to its address to open an item's panel (this one:
  `?item=tasks/onboarding`), and `?view=history` to open the history.
- **LAN:** besides `Local:`, it listens on your private network address (`LAN:`), with no authentication. Start it
  with `--local` on networks you do not trust.

The coordinator gives you these links ready to open. When the kanban is down it gives you the artifact's file path
instead.

## Useful commands

You never need them, but they are there:

- `wip state`: open items; `--attention` lists what waits on you, `--archived` the closed ones.
- `wip show <ID>`: one item with its runs, gates and timeline.
- `wip check`: the invariants of the state.
- `wip flow lint`: validates the flows.
- `wip help` and `wip <command> --help`: the reference.
- `wip web` (`--open`, `--local`, `--port <N>`), `wip web status`, `wip web log -n 20` and `wip web stop`.

## Your own flows and agents

Ask the coordinator: «create a flow for code reviews», «add an agent that writes release notes». It uses the skills
`wip-new-flow` and `wip-new-agent`: a proposal you approve, a backup, the file under `<defs>/`, and `wip flow lint`.
`<defs>/skills/wip-new-flow/example.md` is a complete flow to start from.

## Sessions and restarts

Each session of the coordinator starts with `wip session start`. Subagents of a previous session do not survive a
restart: their runs become `orphaned` and their items wait on you with a `next` that says what to relaunch. Nothing
is relaunched until you ask.

## Where things live

- `.wip/`: the state (`wip.sqlite`), the artifacts of each item in `.wip/items/<flow>/<ID>/`, the logs in
  `.wip/logs/` and the backups of edited definitions in `.wip/backups/`. It is in `.gitignore`.
- `<defs>/agents/`: the coordinator (`wip.md`) and the subagents.
- `<defs>/skills/`: the coordinator's protocol, the flows (`wip-flow-<flow>/`) and the skills to create new ones.
