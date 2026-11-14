---
name: wip-flow-tasks
description: "wip flow `tasks`, for the coordinator: phases, gates and subagents of an item that is a task with a clear outcome (code, a report, a document, a decision), one-off or recurring. Four phases — todo, doing, done, closed — it plans and waits for its schedule, runs, is reviewed, and closes or waits for its next run. Read it before every phase of an item of this flow."
wip: flow
---

# tasks

The default flow: any task with a clear outcome — a change to the project, an investigation, a document, a
decision — one-off or recurring. An item starts when the user asks for something. A one-off ends when the user
accepts the result and the coordinator archives it; a recurring one goes back to `todo` (or stays in `done`) to wait
for its next run. Four phases:

- **todo**: the request, the plan, and the wait between runs. The coordinator saves the user's words; a subagent
  writes `request.md` and `v1.plan.md`, and the user approves the plan. A recurring item returns here after its
  review and waits for its `next_run`.
- **doing**: the work. A subagent carries out the approved plan, checks it and writes `v<N>.report.md`; the review
  happens in `done`.
- **done**: the review of the run and, when `after_review` is `done`, the wait for the next run. The user accepts,
  sends it back or stops it.
- **closed**: terminal, then archived.

`wip init` seeds `onboarding` in `todo` with `guide.md`; the coordinator guides it to `closed` and archives it
(«Onboarding» in `wip-coordinate`).

```wip-flow
version: 1
fields:
  title: string
  schedule: string
  next_run: ts
  after_review: enum(todo|done)
phases:
  - name: todo
    gate: ask
    from_any: true
    next: [doing, closed]
    waiting_default: user
    agent: thinker
    writes: artifacts
  - name: doing
    gate: auto
    next: [done]
    waiting_default: agent
    agent: efficient
    writes: project
  - name: done
    gate: ask
    next: [doing, todo, closed]
    waiting_default: user
  - name: closed
    kind: terminal
    gate: none
    next: []
    waiting_default: none
polling:
  - name: due
    phases: [todo, done]
    agent: fast
    cadence: 1d
seed:
  - id: onboarding
    phase: todo
    title: Get to know wip
    next: tell the coordinator when you want to start the onboarding
    files: [guide.md]
```

## Subagents

Each phase names its default agent (`agent:`) and what its subagent may write (`writes:`). The four generic agents
share one contract and differ in level and cost, from cheapest to most capable: `fast`, `efficient`, `thinker`,
`wise`. `done` and `closed` have no subagent: the coordinator shows the run's report and the user reviews.

- `todo` uses `thinker`: a plan needs decisions. A request that is already a list of literal steps can use
  `efficient`.
- `doing` uses `efficient`: it carries out an approved plan and checks it against written criteria. A purely
  mechanical plan (literal commands, a decided text) can use `fast`; a plan that touches an unknown area or many
  files, or an open investigation, `thinker`.
- The poll `due` uses `fast`: it only reads each item's fields and reports which ones are due.
- `wise` is never the default: use it for high ambiguity or risk, or after `thinker` failed on the same thing.

Every launch passes `Writes:` with the phase's `writes` value, and `Inputs:` with the exact path of each artifact
the phase reads. Pass the user's feedback literally when a phase runs again. `doing` writes only project files and
its `v<N>.report.md`.

### todo

The coordinator does the first step itself: create the item with
`"$WIP_BIN" phase <ID> todo --flow tasks`, save the user's words with `"$WIP_BIN" log <ID> "<their words>" --kind user`
and set the title with `"$WIP_BIN" set <ID> title=<short title>`. Ask the user only what blocks the plan. Then launch
the phase's agent with the user's words literally in `Inputs:`: it writes `request.md` (`## What`, the outcome in the
user's words, and `## Context`, links, files and constraints) and `v1.plan.md` (`v<N+1>.plan.md` on each change) with
the deliverable (code, a report, a document, a decision) and where it lands, the done criteria and how each one is
checked, the steps, what it writes and where, risks and open questions. For a recurring task the plan also states
the schedule (the `schedule` cron, e.g. `0 9 * * 1` for Mondays at 09:00, in local time) and what each run does.

Gate `ask`: the user approves the exact version (`"$WIP_BIN" gate close <ID> --answer "approved v<N>.plan.md"`);
«Change» relaunches the same phase with the latest plan and the user's feedback. A request that needs no work, or
that the user drops, goes straight to `closed` after the `log`. `todo` is reachable from any phase (`from_any`): when
the result shows the plan was wrong, the item goes back here and to its gate.

A recurring task also carries `schedule` (a cron expression in local time) and `next_run` (an ISO 8601 instant),
and `after_review` (`todo`, the default, or `done`). Set them with `"$WIP_BIN" set <ID> schedule="<cron>"
next_run=<ISO 8601> after_review=<todo|done>` when the plan is approved. If `next_run` is already due, move to
`doing` and launch it; otherwise `"$WIP_BIN" wait <ID> external --next "next run <date>"` and arm the moment with
`"$WIP_BIN" cron add --poll tasks/due --at <next_run>`.

When an item returns here from `done`, no plan is written and no gate opens: the coordinator computes the new
`next_run` from `schedule`, updates it, waits and arms the pass the same way.

The flow's `polling` has `fast` check the items in `todo` and `done`: it reads each item's `next_run` and
`waiting_on` with `"$WIP_BIN" show <ID> --json` and reports the ones whose `next_run` has passed and that are not
waiting on the user or a run. The coordinator moves each reported item to `doing` and launches the phase. The
`cadence: 1d` is the safety net for a pass that was lost; the fixed-time pass at `next_run` is the trigger.

### doing

Inputs: the approved `plan.md` version, the run number and, when the review sends the item back, the user's
feedback. `Writes: project`. The subagent produces the deliverable as the plan says, checks it against each done
criterion on its own — runs the tests and commands of a change, confirms each question of an investigation has an
answer and a source, checks a document covers what the plan lists — and writes `v<N>.report.md`, `N` counting the
item's executions (`v1.report.md` on the first): what it produced, each criterion with pass or fail and its
evidence, the files it changed, and deviations from the plan. A deviation that is not trivial, or a red criterion it
cannot fix, comes back as `blocked` or `needs-input` and opens a gate instead of moving on. Gate `auto`: when it
returns `done`, the coordinator moves the item to `done` and opens the review there.

### done

The review. The coordinator shows `v<N>.report.md` and where to look, and opens the gate. For a one-off task,
«Approve» moves the item to `closed` and archives it. For a recurring task, «Approve» computes the next `next_run`
from `schedule` and moves the item back to `todo` — or keeps it in `done` when `after_review=done` — with
`"$WIP_BIN" wait <ID> external --next "next run <date>"` and a fixed-time pass at that moment; either way, nothing is
archived. «Change» relaunches `doing` with the user's feedback, or goes back to `todo` when the plan was wrong.
«Stop» moves the item to `closed` and archives it.

### closed

Terminal. The coordinator moves the item here when the user accepts a one-off, drops a task, or stops a recurring
one, then archives it with `"$WIP_BIN" archive <ID>` when nothing is left open. The onboarding item ends here too.
