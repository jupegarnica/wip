```wip-flow
phases:
  - name: todo
    next: [done]
    waiting_default: human-reviewer
  - name: done
    kind: terminal
```
