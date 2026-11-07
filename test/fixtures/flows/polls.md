# polls

A valid flow with two polls: `waiting` watches the phase `waiting` every hour, `discover` is flow-wide every 30
minutes. Needs the agent `fast`.

```wip-flow
phases:
  - name: intake
    next: [waiting]
    waiting_default: user
  - name: waiting
    kind: wait
    waiting_default: external
    next: [done]
  - name: done
    kind: terminal
polling:
  - name: waiting
    phases: [waiting]
    agent: fast
    cadence: 1h
  - name: discover
    agent: fast
    cadence: 30m
```
