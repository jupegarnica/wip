---
name: wip-flow-development
description: "wip flow `development`, for the coordinator: phases, gates and subagents of an item that is a small piece of work, from the backlog and the plan approved by the user, through a build in its own worktree and branch, a QA plan prepared and run, the user's review, the commit, the release that closes the worktree and publishes the build, and the close. Read it before every phase of an item of this flow."
---

# development

A small piece of work with one plan, one build in a worktree of its own branch, a QA plan prepared and run, the
user's review, one commit and one release. An item starts in `backlog` when the user names the work; it ends in
`close` after the worktree is closed and the build published, or when the user drops it.

```wip-flow
version: 1
color: "#AA3300"
fields:
  title: string
  branch: string
  worktree: string
phases:
  - name: backlog
    gate: none
    next: [plan]
    waiting_default: user
    stage: plan
  - name: plan
    gate: ask
    next: [worktree]
    agent: thinker
    writes: artifacts
    stage: plan
  - name: worktree
    gate: auto
    next: [build]
    agent: efficient
    writes: project
    stage: build
  - name: build
    gate: auto
    next: [qa-plan]
    agent: thinker
    writes: project
    stage: build
  - name: qa-plan
    gate: auto
    next: [qa-exec]
    agent: efficient
    writes: artifacts
    stage: review
  - name: qa-exec
    gate: auto
    next: [human-review, build]
    agent: efficient
    writes: artifacts
    stage: review
  - name: human-review
    gate: none
    next: [build, plan, commit]
    waiting_default: user
    stage: review
  - name: commit
    gate: auto
    next: [release]
    agent: efficient
    writes: project
    stage: review
  - name: release
    gate: ask
    next: [close]
    agent: efficient
    writes: project
    stage: review
  - name: close
    kind: terminal
    stage: review
```

## Subagents

- `plan` uses `thinker`: it writes the plan from the user's request and the project files, deciding what is not written anywhere.
- `worktree` uses `efficient`: it creates the branch and the worktree the build runs in.
- `build` uses `thinker`: it carries out the approved plan literally inside the worktree. A build that hits a decision the plan does not cover returns `needs-input`; the coordinator escalates to `wise`.
- `qa-plan` uses `efficient`: it prepares the environment, the launcher and `qa-plan.md`, and runs no case.
- `qa-exec` uses `efficient` (or `fast` when the steps are mechanical): it runs the cases the plan lists and writes `qa-report.md`.
- `human-review` has no subagent: the coordinator presents the test plan and waits on the user.
- `commit` uses `efficient`: it commits the reviewed work on the item's branch.
- `release` uses `efficient`: it merges the branch, builds the package, installs it globally and removes the worktree, after the user approves the gate.

Every launch passes `Writes:` with the phase's `writes` value, and `Inputs:` with the exact path of each artifact the phase reads.

### backlog

Inputs: the user's words, literally. No subagent runs here: the coordinator logs the words, sets `title` and leaves the item waiting on the user. The user's order to start moves it to `plan`.

### plan

Inputs: the user's request, literally. The subagent writes `v<N>.plan.md`: goal, steps, files to change, checks to run and risks. The gate shows the plan: «Approve» moves to `worktree`; «Change» relaunches `plan` with the user's feedback.

### worktree

Inputs: the approved `v<N>.plan.md`. The subagent creates a git worktree at `.worktrees/<ID>` on a new branch `wip/<ID>`, adding `.worktrees/` to `.gitignore` when it is not there, and reports the branch name and the worktree path. The coordinator records them with `"$WIP_BIN" set <ID> branch=<branch> worktree=<path>`. It returns `done` and moves to `build` without asking.

### build

Inputs: the approved `v<N>.plan.md`, the worktree path from the item's `worktree` field and the branch from `branch`. The subagent makes the change inside the worktree as the plan says and writes `build.md` in `ARTIFACT_DIR`: what changed, which checks ran and their result. When it returns `done`, move to `qa-plan` without asking.

### qa-plan

Inputs: `build.md` and the approved `v<N>.plan.md`. No gate opens on entering `qa-plan`. The subagent prepares, without running any case:

- **An environment** in the item's own `tmp` folder, `ARTIFACT_DIR/tmp/`, where the change can be tried without touching real data or the project's own `.wip/`: a disposable folder (or one per case) and a script that creates a fresh case. Nothing of it goes outside `ARTIFACT_DIR`.
- **A binary or launcher** that runs the build from the worktree, never the one installed globally: the built output of the worktree, or a wrapper that runs the worktree's working tree. It is checked with a smoke run (version and one real command) before it is handed over.
- **A test plan**, `qa-plan.md` in `ARTIFACT_DIR`: the cases to try, each with the exact command or action, the expected result and how to reset; it covers the plan's goal, its error paths and what was not tested by hand (`build.md`, «Checks»). The same text goes in the environment's README.

It writes no other artifact and runs no case. When it returns `done`, move to `qa-exec` without asking.

### qa-exec

Inputs: `qa-plan.md` and `build.md`. The subagent runs the cases it can automate and writes `qa-report.md` in `ARTIFACT_DIR`: each case is passed, failed or left for the user, with the command and the output. All green → move to `human-review` without asking. A failed case returns `blocked`: the coordinator shows it to the user in a gate and decides whether to fix in `build` or continue to the user's review.

### human-review

No subagent runs here. The coordinator presents the user the test plan: the commands to enter the environment, the path of the launcher, the path of `qa-plan.md`, the results from `qa-report.md` and what only the user can test. It waits with `"$WIP_BIN" wait <ID> user --next "test with qa-plan.md"`, not with a gate. The user's literal word «ok» (log it with `"$WIP_BIN" log <ID> "<words>" --kind user`) moves to `commit`; feedback moves to `build` with the same plan (the environment and the worktree are reused and only updated); a change of the plan goes to `plan`, whose gate approves the new version.

### commit

Inputs: `build.md` and the branch from `branch`. The subagent commits the reviewed work inside the worktree on the item's branch, following the repository's commit conventions, and writes `commit.md` in `ARTIFACT_DIR` with the hash and what the commit contains; it does not push, merge or touch another branch. When it returns `done`, move to `release` without asking.

### release

Gate `ask`: the coordinator shows the branch, the commit and the exact commands before anything runs. After the user approves, the subagent:

1. merges `wip/<ID>` into `main` from the main working tree;
2. builds and packs the package from `main` (`bun run build`);
3. installs it globally (the repository's `npm install -g` of the packed package), without touching the existing `wip2`;
4. removes the worktree with `git worktree remove`.

It writes `release.md` in `ARTIFACT_DIR` with the merge, the build output, the installed version and the removal. A merge conflict, a failed build or a failed install returns `blocked` and the worktree stays. When it returns `done`, move to `close`.

### close

Terminal, inside the `review` stage. Archive with `"$WIP_BIN" archive <ID>` when nothing is left open.
