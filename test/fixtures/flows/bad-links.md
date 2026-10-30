```wip-flow
links:
  - pattern: "^T([0-9]+$"
    url: "https://tracker.example.com/t/$1"
phases:
  - name: todo
    next: [done]
  - name: done
    kind: terminal
```
