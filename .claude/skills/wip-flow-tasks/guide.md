---
name: wip-flow-tasks-guide
wip: guide
---

# Get to know wip

This guide describes the defaults `wip init` writes. Your project may have changed its flows and agents since: the
source is always the definitions folder, `<defs>/` (`defs_dir` in `.wip/config.json`, `.claude/` by default; a `defs_dir` that starts with `~/` is in the user's home
folder (`wip init --global`), shared by every project initialised that way).

## What wip is

You talk to one agent — the coordinator. It splits your work into deterministic workflows with named phases,
gates that stop for your decisions, and the subagent each phase runs. Every run, gate and artifact is recorded in
`.wip/`, so you can audit the work and keep control without asking the model what happened.

The workflow is yours to change. Ask the coordinator for the flows you want, the phases in them, and an agent for
each phase with the rules, the model and the write scope you choose. Flows and agents are Markdown under `<defs>/`.

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

`onboarding` is a real item of the `tasks` flow, in `todo`. Its steps show in its `next` on the kanban:

1. Read this guide and find the item on the kanban.
2. Ask the coordinator anything about it, or tell it you have read it.
3. Answer its gate «Close the onboarding?». Approve moves the item to `closed` and archives it.

After that the coordinator suggests your first real task. The guide stays readable from the history of the kanban.

## How to ask for things

Write as you would to a colleague; there are no commands to learn:

- «Fix the failing login test», «Investigate why the build is slow», «Write a summary of the API changes».
- «What is waiting on me?» lists the items whose next step is yours, open gates first.
- «Status of <ID>» gives the phase, who it waits on, its runs and its artifacts.
- «Stop», «change the plan to …» or «use thinker for this» work in the middle of a phase: the coordinator stops or
  relaunches with your words, and records them.

## Flows and stages

`wip init` ships four flows, all selected by default:

- `development`: a small piece of work in a git worktree and branch, with a plan, a build, a QA pass, the user's
  review, one commit and one release.
- `ideas`: shapes an idea before anything is built, in rounds of questions and answers, until it is executed or
  discarded.
- `reports`: a search or a report, one-off or recurring, from the questions and the sources to the written report.
- `tasks`: any task with a clear outcome.

The `tasks` flow has four phases — `todo`, `doing`, `done` and `closed`:

- **todo**: the coordinator saves your words; a subagent writes `request.md` and `v1.plan.md` with what is delivered
  and how it is checked, and you approve the plan. A recurring task waits here for its next run.
- **doing**: a subagent produces the deliverable as the plan says, checks it against the plan's criteria and writes
  `v<N>.report.md`.
- **done**: you review the run's report; a recurring task waits here for its next run when `after_review` says so.
- **closed**: the item ends here and is archived.

A recurring task also carries `schedule` (a cron expression in local time, e.g. `0 9 * * 1` for Mondays at 09:00),
`next_run` (when it runs next) and `after_review` (`todo` or `done`, where it waits between runs).

A typical task: you ask → `todo` (the plan, approved) → `doing` (the work and its check) → `done` (your review) →
`closed`, archived.

## Agents and models

Four generic agents share one contract and differ in level and cost, from cheapest to most capable:

- `fast`: mechanical work with literal steps.
- `efficient`: carrying out a clear plan, a scoped change, a check against written criteria.
- `thinker`: anything that needs decisions: plans, investigations, design.
- `wise`: high ambiguity or risk, or after `thinker` failed on the same thing.

Each phase names its default agent. The coordinator picks a cheaper one when the work is mechanical and escalates one
level when a run fails for difficulty. Every agent comes with a model from its template; ask the coordinator to
change one at any time.

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
| 🟦 | INFO | progress, a launch, an answer |
| 🟩 | DONE | a phase or a piece of work finished, with its time and runs |
| 🟨 | WARNING | an incident or a risk that does not block |
| 🟪 | NEXT | the last line of every turn: what you can do next |
| 🟧 | gate | a decision of yours, as the last text of the turn |
| 🟥 | ACTION | something only you can do, or something blocks progress |

## The kanban

`"$WIP_BIN" web` serves a read-only kanban of this project. The coordinator brings it up at the start of each session and
gives you its LAN address (`LAN:`, `http://<your-ip>:33333/` or the next free port), rather than `localhost`; when the
server has no LAN address (`--local`) it gives you the `Local:` one instead.

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

The coordinator gives you these links ready to open. When the kanban is down it gives you each file's path relative
to the project, starting with `./`, instead.

## Useful commands

You never need them, but they are there:

- `"$WIP_BIN" state`: open items; `--attention` lists what waits on you, `--archived` the closed ones.
- `"$WIP_BIN" show <ID>`: one item with its runs, gates and timeline.
- `"$WIP_BIN" check`: the invariants of the state.
- `"$WIP_BIN" flow lint`: validates the flows.
- `"$WIP_BIN" help` and `"$WIP_BIN" <command> --help`: the reference.
- `"$WIP_BIN" web` (`--open`, `--local`, `--port <N>`), `"$WIP_BIN" web status`, `"$WIP_BIN" web log -n 20` and `"$WIP_BIN" web stop`.

## Your own flows and agents

The defaults are only a starting point. By talking to the coordinator you can:

- **Edit a flow or an agent.** Say what changes («split `doing` into `execute` and `check` in `tasks`», «make the plan gate optional»).
  The coordinator proposes the new text and waits for your approval; a subagent then writes it with a backup under
  `.wip/backups/defs/` and runs `"$WIP_BIN" flow lint`.
- **Disable a flow you do not use.** `"$WIP_BIN" flow disable <flow>` hides it and freezes its items without touching
  any file; `"$WIP_BIN" flow enable <flow>` brings it back. Ask the coordinator when you want it off or on again.
- **Create a new flow or agent.** «create a flow for code reviews», «add an agent that writes release notes». The
  coordinator uses the skills `wip-new-flow` and `wip-new-agent`: a proposal you approve, a backup, the file under
  `<defs>/`, and `"$WIP_BIN" flow lint`. `<defs>/skills/wip-new-flow/example.md` is a complete flow to start from.

You choose the phases and, for each one, the agent and the instructions it follows; agents are Markdown too, with
their rules and their model.

## Sessions and restarts

Each session of the coordinator starts with `"$WIP_BIN" session start`. Subagents of a previous session do not survive a
restart: their runs become `orphaned` and their items wait on you with a `next` that says what to relaunch. Nothing
is relaunched until you ask.

## Where things live

- `.wip/`: the state (`wip.sqlite`), the artifacts of each item in `.wip/items/<flow>/<ID>/`, the logs in
  `.wip/logs/` and the backups of edited definitions in `.wip/backups/`. It is in `.gitignore`.
- `<defs>/agents/`: the coordinator (`wip.md`) and the subagents.
- `<defs>/skills/`: the coordinator's protocol, the flows (`wip-flow-<flow>/`) and the skills to create new ones.
