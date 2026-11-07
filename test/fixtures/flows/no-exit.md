```wip-flow
phases:
  - name: todo
    next: [done, loop]
  - name: loop
    next: [spin]
  - name: spin
    next: [loop]
  - name: done
    kind: terminal
```
