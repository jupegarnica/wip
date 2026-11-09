---

name: wip-flow-ideas
description: "wip flow `ideas`, for the coordinator: phases, gates and subagents of an item that is an idea, from its first words, refined by questions and answers, to a final written idea that waits to be executed or is discarded. Read it before every phase of an item of this flow."
---

# ideas

An idea that is shaped before anything is built. An item starts with the user's raw idea; it is refined in rounds of
questions and answers, written as a final artifact, and then it waits in `will` until the user decides to execute it
or to discard it. It ends in `done` or `discarded`, both archived; `will` is not archived. Three stages:

- **backlog**
  - `initial`: state only; the first `refine` subagent writes `v0.idea.md` with the user's raw idea.
- **ongoing**
  - `refine`: a subagent and the user shape the idea in rounds of questions and answers.
  - `final`: a subagent writes the refined idea.
- **done**
  - `will`: the refined idea waits, on the list of ideas pending execution.
  - `done`: the idea was executed.
  - `discarded`: the idea is dropped.

```wip-flow
version: 1
color: "#A855F7"
fields:
  title: string
phases:
  - name: initial
    stage: backlog
    gate: none
    next: [refine, discarded]
    waiting_default: user
  - name: refine
    stage: ongoing
    gate: ask
    next: [final, discarded]
    agent: thinker
    writes: artifacts
  - name: final
    stage: ongoing
    gate: ask
    next: [will, refine, discarded]
    agent: efficient
    writes: artifacts
  - name: will
    stage: done
    kind: wait
    next: [done, discarded, refine]
    waiting_default: external
  - name: done
    stage: done
    kind: terminal
  - name: discarded
    stage: done
    kind: terminal
```

## Subagents

Each phase names its default agent (`agent:`) and what its subagent may write (`writes:`). The generic agents differ
in level and cost, from cheapest to most capable: `fast`, `efficient`, `thinker`, `wise`. `initial` and `will` have
no subagent: the coordinator runs them with the user. A subagent never asks the user anything: its questions come
back in its artifact and the coordinator puts them to the user.

- `refine` uses `thinker`: it decides which questions matter and weighs the idea's options.
- `final` uses `efficient`: it writes up what `refine` settled and decides nothing new.
- `wise` is never the default: use it for an idea of high ambiguity or risk, or after `thinker` failed on the same
  thing.

Every launch passes `Writes:` with the phase's `writes` value, and `Inputs:` with the exact path of each artifact the
phase reads. Pass the user's answers literally when a phase runs again.

### initial

The coordinator does this phase itself, with no subagent and no file. Create the item with
`"$WIP_BIN" phase <ID> initial --flow ideas`, save the user's words with `"$WIP_BIN" log <ID> "<their words>" --kind user`
and set the title with `"$WIP_BIN" set <ID> title=<short title>`. Ask the user nothing that does not block moving on.
Move to `refine`; an idea the user drops goes straight to `discarded` after the `log`.

### refine

Inputs: in the first round, the user's raw idea literally (`idea.md` does not exist yet); from the second, `idea.md` and
the latest `vN.refine.md` with the user's answers. In the first round `Task:` includes «write `idea.md` with the user's
literal words, without summarising»: `## Idea` (the idea in the user's words) and `## Context` (links, files, motivation,
what triggered it). Each round is one
run of the subagent. It reads the inputs and the code or documents the idea touches, and writes `v1.refine.md`
(`v<N+1>.refine.md` on each round) with:

- what it understands so far: the goal, who it is for, the scope, what is out of scope;
- the pros, the cons, the risks, the alternatives and what it would cost;
- the open points that remain;
- 3 to 5 questions for the next round, each one aimed at the open point that moves the idea most.

Gate `ask`: the block shows what is understood and the questions. «Change» carries the user's answers: record them
with `"$WIP_BIN" log <ID> "<their answers>" --kind user` and relaunch the same phase with the latest version and the
answers literally. «Approve» means the idea is clear enough: move to `final`. The user can also send it to
`discarded`.

### final

Inputs: the latest `refine` version and the user's answers. The subagent writes `v1.idea.md`
(`v<N+1>.idea.md` on each change): a title and a one-paragraph summary, the objective, the users and cases, the
pros, the cons, the risks, the scope and what is out of scope, the open questions that remain and a suggested next
step (which flow could execute it). It invents nothing that `refine` did not settle. Gate `ask`: the user approves
the exact version (`"$WIP_BIN" gate close <ID> --answer "approved v<N>.idea.md"`). Approve → `will`. «Change» relaunches
the same phase with the user's feedback; an idea that needs more shaping goes back to `refine`.

### will

The coordinator does this phase itself. The item stays open on the list of ideas waiting to be executed; set it
with `"$WIP_BIN" wait <ID> external --next "execute or discard"`. It is not archived. When the user decides to execute it,
the coordinator offers to start an item of the flow that fits (`dev` or `tasks`) with the approved
`v<N>.idea.md` as its context. When the user says it was executed, it moves to `done`; when the user drops it, it moves
to `discarded`; one that needs more shaping goes back to `refine`.

### done

Terminal. The coordinator moves the item here after the user says the idea was executed, with
`"$WIP_BIN" log <ID> "<their words>" --kind user`, then archives it with `"$WIP_BIN" archive <ID>` when nothing is
left open.

### discarded

Terminal. The coordinator moves the item here after `"$WIP_BIN" log <ID> "<their words>" --kind user`, then archives it
with `"$WIP_BIN" archive <ID>` when nothing is left open.
