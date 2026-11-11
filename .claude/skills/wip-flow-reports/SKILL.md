---
name: wip-flow-reports
description: "wip flow `reports`, for the coordinator: phases, gates and subagents of a search or a report request — the questions, the sources, their verification and the final report, one-off or recurring. Read it before every phase of an item of this flow."
wip: flow
---

# reports

Reports and searches with an outcome: the user asks for something to find out or to read, and an item delivers a
written report with its sources. An item starts when the user asks; it ends in `done` when the user accepts the
report and stops the recurrence (or when it is a one-off). A recurring item goes back to `waiting` after each
approved report and runs again when its `next_run` is due.

```wip-flow
version: 1
color: "#0D9488"
fields:
  title: string
  cadence: string
  next_run: ts
phases:
  - name: request
    stage: research
    gate: none
    next: [plan]
    waiting_default: user
  - name: plan
    stage: research
    gate: ask
    from_any: true
    next: [search]
    agent: thinker
    writes: artifacts
  - name: search
    stage: research
    gate: auto
    next: [check]
    agent: thinker
    writes: artifacts
  - name: check
    stage: research
    gate: auto
    next: [search, report]
    agent: efficient
    writes: artifacts
  - name: report
    stage: report
    gate: auto
    next: [review]
    agent: thinker
    writes: artifacts
  - name: review
    stage: report
    gate: ask
    next: [search, report, waiting, done]
    waiting_default: user
  - name: waiting
    stage: close
    kind: wait
    gate: none
    next: [search]
    waiting_default: external
  - name: done
    kind: terminal
    stage: close
    from_any: true
polling:
  - name: due
    phases: [waiting]
    agent: fast
    cadence: 1h
```

## Subagents

Each phase names its default agent (`agent:`) and what its subagent may write (`writes:`). `request`, `waiting` and
`done` have no subagent: the coordinator runs them.

- `plan` uses `thinker`: it decides the questions, the sources and what counts as answered.
- `search` uses `thinker`: it judges sources and relevance. Collecting from known paths or running literal queries can
  use `efficient`.
- `check` uses `efficient`: it checks the sources against the plan's written criteria.
- `report` uses `thinker`: it writes the report with judgement, citing the evidence.

Every launch passes `Writes:` with the phase's `writes` value and `Inputs:` with the exact artifact paths; the user's
words go literally when they are the input.

### request

The coordinator does this phase itself, with no subagent and no file. Create the item with
`"$WIP_BIN" phase <ID> request --flow reports`, save the user's words with
`"$WIP_BIN" log <ID> "<their words>" --kind user` and set the title with
`"$WIP_BIN" set <ID> title=<short title>`. When the request is recurring, set `cadence` (for example `1d` or `1w`).
Leave it waiting on the user: their order to start moves it to `plan`. A request that needs no work, or that the user
drops, goes straight to `done` after the log.

### plan

Inputs: the user's words, literally (the subagent writes `request.md` with them first). It writes `v1.plan.md` with:
the questions to answer, the sources to use (the web, the docs, the project files, a repository, another flow's items),
the shape of the report, and the criteria that count each question as answered. For a report about another flow, the
plan names the flow and the phases to watch. Gate `ask`: the user approves the questions, the sources and the
criteria; «Change» relaunches `plan` with their feedback.

### search

Inputs: the approved `v<N>.plan.md`. The subagent runs the plan and writes `sources.md`: each question with its
evidence, the source (link, quote or command) and when it was fetched. For the project's own state, it reads
`"$WIP_BIN" state --flow <flow>` and the items' artifacts. It runs no gate: when it returns `done`, move to `check`.

### check

Inputs: the approved `v<N>.plan.md` and `sources.md`. The subagent verifies each criterion: every question has
evidence, every link answered when it was fetched, the quotes match. It writes `check.md`: each question with pass or
fail and its evidence. All green → `report`; red → back to `search` with the gaps. Red twice for the same reason, or a
criterion the plan got wrong, goes back to `plan` (`from_any`) and its gate.

### report

Inputs: the approved `v<N>.plan.md`, `sources.md` and `check.md`. The subagent writes `report.md`: the answer to each
question with its citations, what was not found, disagreements between sources and the limits of the search. When it
returns `done`, move to `review`.

### review

The coordinator does this phase itself, with no subagent. Gate `ask` with `report.md`: what the report answers, what
it leaves open and where to read it. «Approve» ends a one-off item in `done`; for a recurring item (`cadence` set) it
moves to `waiting` after the coordinator sets `next_run` to the next occurrence. «Change» goes back to `search` (more
sources), `report` (rewrite) or `plan` (change the questions), with the user's feedback.

### waiting

The item waits for its next run. The coordinator sets `next_run` (a `ts` field) to the next occurrence of `cadence`
when the item enters this phase, and leaves it waiting on `external` with a `next` that names the date. The flow's
poll `due` (agent `fast`, cadence `1h`) looks at the items in `waiting`; when a `next_run` is due, the coordinator
moves the item to `search`, reusing the approved plan, and logs the run. `plan` stays reachable from any phase to
change the standing plan.

### done

Terminal, reachable from any phase (`from_any`) so an item can be dropped once the user says so. The coordinator
moves the item here when the user approves a one-off report or stops a recurring one, then archives it with
`"$WIP_BIN" archive <ID>` when nothing is left open. The report stays in the item's artifact directory.
