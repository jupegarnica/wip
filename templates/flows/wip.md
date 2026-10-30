# wip

The default flow: a task with a clear outcome, planned, executed and verified. An item starts when the user asks
for something; it ends when the user accepts the verified result.

- `intake`: the coordinator writes `request.md` with the user and sets the title.
- `plan`: a subagent writes `plan.md`; the user approves it.
- `execute`: a subagent changes the project as the plan says.
- `verify`: a subagent checks the result against the plan's done criteria; the user closes the item or sends it
  back to `plan` or `execute`.
- `done`: closed.

```wip-flow
version: 1
fields:
  title: string
phases:
  - name: intake
    gate: none
    next: [plan]
    waiting_default: user
  - name: plan
    gate: ask
    next: [execute]
    agent: thinker
    writes: artifacts
  - name: execute
    gate: auto
    next: [verify]
    agent: efficient
    writes: project
  - name: verify
    gate: ask
    next: [plan, execute, done]
    agent: efficient
    writes: artifacts
  - name: done
    kind: terminal
```

## Subagents

Each phase names its default agent (`agent:`) and what its subagent may write (`writes:`). The four generic agents
share one contract and differ in level and cost, from cheapest to most capable: `fast`, `efficient`, `thinker`,
`wise`.

- `plan` uses `thinker`: a plan needs decisions. A request that is already a list of literal steps can use
  `efficient`.
- `execute` uses `efficient`: it carries out an approved plan. A purely mechanical plan (literal commands, a decided
  text) can use `fast`; a plan that touches an unknown area or many files, `thinker`.
- `verify` uses `efficient`: it checks written criteria. When the checks are only literal commands to run and
  summarise, `fast` is enough.
- `wise` is never the default: use it for high ambiguity or risk, or after `thinker` failed on the same thing.

Every launch passes `Writes:` with the phase's `writes` value, and `Inputs:` with the exact path of each artifact
the phase reads. Pass the user's feedback literally when a phase runs again.

### intake

The coordinator does this phase itself, with no subagent. Create the item with
`wip phase <ID> intake --flow wip`, then `wip set <ID> title=<short title>`. Write `request.md` in the item's
artifact directory with `## What` (the outcome the user wants, in their words) and `## Context` (links, files,
constraints). Ask the user only what blocks writing a plan. When `request.md` says what done looks like, move to
`plan`.

### plan

Inputs: `request.md`. The subagent writes `v1.plan.md` (`v<N+1>.plan.md` on each change) with: done criteria, steps,
what it writes and where, how it is verified, risks and open questions. Gate `ask`: the user approves the exact
version (`wip gate close <ID> --answer "approved v<N>.plan.md"`). On «Change», relaunch the same phase with the
latest plan and the user's feedback.

### execute

Inputs: the approved `plan.md` version. `Writes: project`. The subagent changes the project as the plan says, runs
the plan's checks and writes `execute-report.md`: what changed (files), the result of each check, deviations from
the plan. A deviation that is not trivial comes back as `needs-input` and opens a gate instead of moving on. When
it returns `done`, move to `verify` without asking.

### verify

Inputs: the approved `plan.md` and `execute-report.md`. The subagent runs the plan's checks again on its own and
writes `verify.md`: each done criterion with pass or fail and its evidence, and the list of changed files. Gate
`ask` with the result: «Approve» moves to `done`; «Change» goes back to `execute` (a fix) or `plan` (the approach
was wrong) with the user's feedback.

### done

Terminal. The coordinator moves the item here after the user approves `verify`, then archives it with
`wip archive <ID>` when nothing is left open.
