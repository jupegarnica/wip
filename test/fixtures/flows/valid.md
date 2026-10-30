# valid

A flow with every key of the block. The phase table below is decoration: it does not match the block on
purpose, and lint ignores it.

| Phase | Gate |
|---|---|
| `intake` | ask |
| `review` | auto |

```wip-flow
version: 1
id_pattern: "T[0-9]+"
fields:
  title: string
  attempts: int
  tags: list
  due: ts
  size: enum(s|m|l)
links:
  - pattern: "^T([0-9]+)$"
    url: "https://tracker.example.com/t/$1"
phases:
  - name: intake
    kind: work
    gate: none
    next: [plan]
    waiting_default: user
    stage: todo
  - name: plan
    kind: work
    gate: ask
    next: [execute]
    stage: doing
    agent: thinker
    writes: artifacts
  - name: execute
    gate: auto
    next: [verify]
    stage: doing
    agent: efficient
    writes: project
  - name: verify
    gate: ask
    next: [plan, execute, done]
    stage: doing
    agent: efficient
  - name: done
    kind: terminal
    stage: closed
```

## Subagents

Use `thinker` to plan and `efficient` to execute.

### plan

Write plan.md in the artifact directory.

### `execute`

Change the project as the plan says.

## Notes

Not a phase section.
