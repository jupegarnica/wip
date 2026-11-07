```wip-flow
version: 2
schedule: []
fields:
  title: string
  phase: string
  owner: person
phases:
  - name: todo
    kind: busy
    gate: maybe
    next: done
  - name: done
    kind: terminal
```
