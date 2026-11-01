---
name: wip-flow-tasks
description: "wip flow `tasks`, for the coordinator: phases, gates and subagents of an item that is a task with a clear outcome (code, a report, a document, a decision), prepared, executed, checked and reviewed. Read it before every phase of an item of this flow."
wip: flow
---

# tasks

The default flow: any task with a clear outcome — a change to the project, an investigation, a document, a
decision. An item starts when the user asks for something; it ends when the user accepts the result and, if it goes
outside the project, once it is delivered. Three stages:

- **preparation**
  - `intake`: the coordinator writes `request.md` with the user and sets the title.
  - `research`: a subagent gathers context, sources and options. Skipped when the request is already clear.
  - `plan`: a subagent writes `plan.md`, which always fixes WHAT is delivered and HOW it is checked; the user
    approves it.
- **execution**
  - `execute`: a subagent produces the deliverable as the plan says.
  - `check`: a subagent checks the result against the plan's criteria; red goes back to `execute`.
- **review**
  - `review`: the user validates the result.
  - `deliver`: only when something is written outside the project (a pull request, a message, a ticket).
  - `done`: closed.

`wip init` seeds `onboarding` in `intake` with `guide.md`; the coordinator guides it to `done` and archives it
(«Onboarding» in `wip-coordinate`).

```wip-flow
version: 1
fields:
  title: string
phases:
  - name: intake
    stage: preparation
    gate: none
    next: [research, done]
    waiting_default: user
  - name: research
    stage: preparation
    gate: auto
    next: [plan]
    agent: thinker
    writes: artifacts
  - name: plan
    stage: preparation
    gate: ask
    from_any: true
    next: [execute]
    agent: thinker
    writes: artifacts
  - name: execute
    stage: execution
    gate: auto
    next: [check]
    agent: efficient
    writes: project
  - name: check
    stage: execution
    gate: auto
    next: [execute, review]
    agent: efficient
    writes: artifacts
  - name: review
    stage: review
    gate: ask
    next: [execute, deliver, done]
    waiting_default: user
  - name: deliver
    stage: review
    gate: ask
    next: [done]
    agent: efficient
    writes: artifacts
  - name: done
    stage: review
    kind: terminal
seed:
  - id: onboarding
    phase: intake
    title: Get to know wip
    next: tell the coordinator when you want to start the onboarding
    files: [guide.md]
```

## Subagents

Each phase names its default agent (`agent:`) and what its subagent may write (`writes:`). The four generic agents
share one contract and differ in level and cost, from cheapest to most capable: `fast`, `efficient`, `thinker`,
`wise`. `intake` and `review` have no subagent: the coordinator runs them with the user.

- `research` uses `thinker`: it decides what matters and compares options. Collecting data from known paths or
  running literal queries can use `efficient`, or `fast` when nothing is left to judge.
- `plan` uses `thinker`: a plan needs decisions. A request that is already a list of literal steps can use
  `efficient`.
- `execute` uses `efficient`: it carries out an approved plan. A purely mechanical plan (literal commands, a decided
  text) can use `fast`; a plan that touches an unknown area or many files, or an open investigation, `thinker`.
- `check` uses `efficient`: it checks written criteria. When the checks are only literal commands to run and
  summarise, `fast` is enough; when judging the result needs expertise (the quality of a source, a design), `thinker`.
- `deliver` uses `efficient`: it drafts the text for the outside and, relaunched with `APPROVED`, publishes it. A
  text already decided word for word can use `fast`.
- `wise` is never the default: use it for high ambiguity or risk, or after `thinker` failed on the same thing.

Every launch passes `Writes:` with the phase's `writes` value, and `Inputs:` with the exact path of each artifact
the phase reads. Pass the user's feedback literally when a phase runs again. `deliver` writes only artifacts: the
write outside the project is allowed by the gate's `APPROVED`, never by `writes`.

### intake

The coordinator does this phase itself, with no subagent. Create the item with
`wip phase <ID> intake --flow tasks`, then `wip set <ID> title=<short title>`. Write `request.md` in the item's
artifact directory with `## What` (the outcome the user wants, in their words) and `## Context` (links, files,
constraints). Ask the user only what blocks preparing the work. When the request names what to deliver and leaves
nothing to find out first, move to `plan`; otherwise move to `research`. A request that needs no work, or that the
user drops, goes straight to `done` after `wip log <ID> "<their words>" --kind user`.

### research

Inputs: `request.md`. The subagent gathers what the plan needs — the relevant code or documents, sources, constraints
and the options with their trade-offs — and writes `investigation.md`: findings with their source (path, link,
command), the options compared, open questions. Gate `auto`: when it returns `done`, move to `plan` without asking;
questions only the user can answer open a gate.

### plan

Inputs: `request.md` and `investigation.md` when it exists. The subagent writes `v1.plan.md` (`v<N+1>.plan.md` on
each change) with: the deliverable (code, a report, a document, a decision) and where it lands, the done criteria
and how each one is checked (tests or commands for a change, each question answered with its source for an
investigation, the points a document must cover), the steps, what it writes and where, risks and open questions.
Gate `ask`: the user approves the exact version (`wip gate close <ID> --answer "approved v<N>.plan.md"`). On
«Change», relaunch the same phase with the latest plan and the user's feedback.

### execute

Inputs: the approved `plan.md` version, and `check.md` when `check` sends the item back. `Writes: project`. The
subagent produces the deliverable as the plan says and writes `execute-report.md`: what it produced (files,
sections, answers), the result of each check it ran, deviations from the plan. A deviation that is not trivial
comes back as `needs-input` and opens a gate instead of moving on. When it returns `done`, move to `check` without
asking.

### check

Inputs: the approved `plan.md` and `execute-report.md`. The subagent checks the result against each done criterion
on its own — runs the tests and commands of a change, confirms each question of an investigation has an answer and
a source, checks a document covers what the plan lists — and writes `check.md`: each criterion with pass or fail and
its evidence, and the list of changed files. All green → `review` without asking. Red → back to `execute` with
`check.md` as input; red twice for the same reason, or a criterion the plan got wrong, opens a gate. `plan` is reachable from any phase
(`from_any`), so a criterion the plan got wrong goes back to `plan` and its gate.

### review

The coordinator does this phase itself, with no subagent. Gate `ask` with the result: what was delivered, `check.md`
and where to look. «Approve» moves to `done`, or to `deliver` when the plan writes something outside the project;
«Change» goes back to `execute` (a fix) or `plan` (the approach was wrong; `plan` is reachable from any phase) with
the user's feedback.

### deliver

Inputs: the approved `plan.md`, `check.md` and the user's answer in `review`. The subagent drafts what goes outside
(the pull request body, the message, the ticket comment) as `v1.deliver.md`. Gate `ask`: the user approves the exact
text; then relaunch with `APPROVED` and that version, and the subagent publishes it and records the links in
`delivered.md`. When it returns `done`, move to `done`.

### done

Terminal. The coordinator moves the item here after the user approves `review` or once `deliver` is published, then
archives it with `wip archive <ID>` when nothing is left open.
