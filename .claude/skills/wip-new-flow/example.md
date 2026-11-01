---
name: wip-flow-review
description: "wip flow `review`, for the coordinator: phases, gates and subagents of an item that is a review of someone else's change (a pull request, a document, a design), from reading it to the published answer. Read it before every phase of an item of this flow."
wip: example
---

# review

A review of a change someone else made. An item starts when the user names the change to review; it ends when the
approved answer is published, or the user drops it.

This file is the reference of `wip-new-flow`, not an active flow. To use it, copy it to
`<defs>/skills/wip-flow-<name>/SKILL.md`, set `name: wip-flow-<name>`, drop the `wip:` line and change what the proposal says.

```wip-flow
version: 1
id_pattern: "[A-Za-z0-9-]{1,40}"
fields:
  title: string
  source: string
phases:
  - name: intake
    gate: none
    next: [read]
    waiting_default: user
    stage: todo
  - name: read
    gate: auto
    next: [answer]
    agent: thinker
    writes: artifacts
    stage: review
  - name: answer
    gate: ask
    next: [read, waiting, done]
    agent: efficient
    writes: artifacts
    stage: review
  - name: waiting
    kind: wait
    gate: none
    next: [read, done]
    waiting_default: external
    stage: waiting
  - name: done
    kind: terminal
    stage: closed
```

## Subagents

- `read` uses `thinker`: reviewing needs judgement. A change of a few lines with written criteria can use
  `efficient`.
- `answer` uses `efficient`: it turns the findings into the text to publish. Publishing is a proposal until the user
  approves the exact text.

Every launch passes `Writes:` with the phase's `writes` value, and `Inputs:` with the exact path of each artifact
the phase reads.

### intake

The coordinator does this phase itself. Create the item with `wip phase <ID> intake --flow review`, then
`wip set <ID> title=<short title> source=<link or path of the change>`. Move to `read` when the change is reachable.

### read

Inputs: `source`. The subagent reads the change and writes `review-notes.md`: each finding with its place, its
severity and why it matters. When it returns `done`, move to `answer` without asking.

### answer

Inputs: `review-notes.md`. The subagent writes `v1.answer.md` (`v<N+1>.answer.md` on each change): the text to
publish. Gate `ask`: «Approve» relaunches the phase with `APPROVED` to publish it and moves to `waiting`; «Change»
relaunches it with the user's feedback; back to `read` when the change itself moved.

### waiting

The author answers outside the session: `wip wait <ID> external --next "<what we wait for>"`. New commits go back to
`read`; an accepted answer goes to `done`.

### done

Terminal. Archive with `wip archive <ID>` when nothing is left open.
