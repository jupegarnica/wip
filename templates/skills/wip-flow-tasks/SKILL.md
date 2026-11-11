---
name: wip-flow-tasks
description: "wip flow `tasks`, for the coordinator: phases, gates and subagents of an item that is a task with a clear outcome (code, a report, a document, a decision). Three phases — todo, doing, done — plan it, do and check it, and close it with the user's review. Read it before every phase of an item of this flow."
wip: flow
---

# tasks

The default flow: any task with a clear outcome — a change to the project, an investigation, a document, a
decision. An item starts when the user asks for something; it ends when the user accepts the result. Three stages,
one phase each, with the same names:

- **todo** · `todo`: the request and the plan. The coordinator saves the user's words; a subagent writes
  `request.md` and `v1.plan.md`, and the user approves the plan.
- **doing** · `doing`: the work. A subagent carries out the approved plan, checks it against the plan's criteria and
  writes `execute-report.md`; the user reviews the result.
- **done** · `done`: closed, then archived.

`wip init` seeds `onboarding` in `todo` with `guide.md`; the coordinator guides it to `done` and archives it
(«Onboarding» in `wip-coordinate`).

```wip-flow
version: 1
fields:
  title: string
phases:
  - name: todo
    stage: todo
    gate: ask
    from_any: true
    next: [doing, done]
    waiting_default: user
    agent: thinker
    writes: artifacts
  - name: doing
    stage: doing
    gate: ask
    next: [done]
    waiting_default: agent
    agent: efficient
    writes: project
  - name: done
    stage: done
    kind: terminal
    gate: none
    next: []
    waiting_default: none
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
`wise`. `done` has no subagent: the coordinator closes the item with the user.

- `todo` uses `thinker`: a plan needs decisions. A request that is already a list of literal steps can use
  `efficient`.
- `doing` uses `efficient`: it carries out an approved plan and checks it against written criteria. A purely
  mechanical plan (literal commands, a decided text) can use `fast`; a plan that touches an unknown area or many
  files, or an open investigation, `thinker`.
- `wise` is never the default: use it for high ambiguity or risk, or after `thinker` failed on the same thing.

Every launch passes `Writes:` with the phase's `writes` value, and `Inputs:` with the exact path of each artifact
the phase reads. Pass the user's feedback literally when a phase runs again. `doing` writes only project files and
its `execute-report.md`.

### todo

The coordinator does the first step itself: create the item with
`"$WIP_BIN" phase <ID> todo --flow tasks`, save the user's words with `"$WIP_BIN" log <ID> "<their words>" --kind user`
and set the title with `"$WIP_BIN" set <ID> title=<short title>`. Ask the user only what blocks the plan. Then launch
the phase's agent with the user's words literally in `Inputs:`: it writes `request.md` (`## What`, the outcome in the
user's words, and `## Context`, links, files and constraints) and `v1.plan.md` (`v<N+1>.plan.md` on each change) with
the deliverable (code, a report, a document, a decision) and where it lands, the done criteria and how each one is
checked, the steps, what it writes and where, risks and open questions. Gate `ask`: the user approves the exact
version (`"$WIP_BIN" gate close <ID> --answer "approved v<N>.plan.md"`); «Change» relaunches the same phase with the
latest plan and the user's feedback. A request that needs no work, or that the user drops, goes straight to `done`
after the `log`. `todo` is reachable from any phase (`from_any`): when the result shows the plan was wrong, the item
goes back here and to its gate.

### doing

Inputs: the approved `plan.md` version and, when the review sends the item back, the user's feedback. `Writes:
project`. The subagent produces the deliverable as the plan says, checks it against each done criterion on its own
— runs the tests and commands of a change, confirms each question of an investigation has an answer and a source,
checks a document covers what the plan lists — and writes `execute-report.md`: what it produced, each criterion
with pass or fail and its evidence, the files it changed, and deviations from the plan. A deviation that is not
trivial, or a red criterion it cannot fix, comes back as `blocked` or `needs-input` and opens a gate instead of
moving on. Gate `ask`: the coordinator shows the result, `execute-report.md` and where to look, and the user approves
it before `done`; «Change» relaunches this phase with the user's feedback, or goes back to `todo` when the plan was
wrong.

### done

Terminal. The coordinator moves the item here after the user approves the result in `doing`, then archives it with
`"$WIP_BIN" archive <ID>` when nothing is left open. The onboarding item ends here the same way.
