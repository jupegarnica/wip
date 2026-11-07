---

name: wip-flow-development
description: "wip flow `development`, for the coordinator: phases, gates and subagents of an item that is a small piece of work, from a written plan approved by the user, through its build, to the user's review and close. Read it before every phase of an item of this flow."
---

# development

A small piece of work with one plan, one build and one review by the user. An item starts when the user names the
work; it ends in `close` when the user accepts the build, or when the user drops it.

```wip-flow
version: 1
fields:
  title: string
phases:
  - name: plan
    gate: ask
    next: [build]
    agent: thinker
    writes: artifacts
    stage: plan
  - name: build
    gate: auto
    next: [review]
    agent: thinker
    writes: project
    stage: build
  - name: review
    gate: none
    next: [build, close]
    agent: efficient
    stage: review
  - name: close
    kind: terminal
    stage: review
```

## Subagents

- `plan` uses `thinker`: it writes the plan from the user's request and the project files, deciding what is not written anywhere.
- `build` uses `thinker`: it carries out the approved plan literally. A build that hits a decision the plan does not
  cover returns `needs-input`; the coordinator escalates to `wise`.

- `review` uses `efficient` (or `fast` when the steps are mechanical): it prepares the environment, the launcher and
  `qa-plan.md`, then runs itself the cases it can automate and writes `qa-report.md`; the user does the final manual
  test.

Every launch passes `Writes:` with the phase's `writes` value, and `Inputs:` with the exact path of each artifact
the phase reads.

### plan

Inputs: the user's request, literally. The subagent writes `v<N>.plan.md`: goal, steps, files to change, checks to run
and risks. The gate shows the plan: «Approve» moves to `build`; «Change» relaunches `plan` with the user's feedback.

### build

Inputs: the approved `v<N>.plan.md`, named by its exact path. The subagent makes the change in the project as the plan
says and writes `build.md`: what changed, which checks ran and their result. When it returns `done`, move to
`review` without asking.

### review

Inputs: `build.md`. No gate opens on entering `review`. The coordinator launches a subagent (`efficient`, or `fast`
when the steps are mechanical; `Writes: artifacts`) that prepares:

- **An environment** in the item's own `tmp` folder, `ARTIFACT_DIR/tmp/` (for example
  `.wip/items/development/<ID>/tmp`), where the change can be tried without touching real data or the project's own
  `.wip/`: a disposable folder (or one per case) and a script that creates a fresh case. Nothing of it goes outside
  `ARTIFACT_DIR`.
- **A binary or launcher** that runs the build, never the one installed globally: the built output of the project, or
  a wrapper that runs the working tree. It is checked with a smoke run (version and one real command) before it is
  handed over.
- **A test plan**, `qa-plan.md` in `ARTIFACT_DIR`: the cases to try, each with the exact command or action, the
  expected result and how to reset; it covers the plan's goal, its error paths and what was not tested by hand
  (`build.md`, «Checks»). The same text goes in the environment's README.

Then the subagent runs the cases it can automate and writes `qa-report.md` in `ARTIFACT_DIR`: each case is passed,
failed or left for the user, with the command and the output.

When the subagent returns `done`, the coordinator presents the user the test plan: the commands to enter the
environment, the path of the launcher, the path of `qa-plan.md`, the subagent's results from `qa-report.md` and what
only the user can test. It waits with `"$WIP_BIN" wait <ID> user --next "test with qa-plan.md"`, not with a gate. The
user's literal word «ok» (log it with `"$WIP_BIN" log <ID> "<words>" --kind user`) moves to `close`; feedback moves to
`build` with the same plan (the environment is reused and only updated); a change of the plan itself goes back to
`plan`. If the subagent's own run finds a failed case, the coordinator shows it to the user in a gate before deciding:
fix in `build` or continue to the user's test.

### close

Terminal, inside the `review` stage. Archive with `"$WIP_BIN" archive <ID>` when nothing is left open.
