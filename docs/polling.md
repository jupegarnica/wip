# Polling

[← Back to the README](../README.md)

Nothing in wip runs by itself. A flow can declare scheduled checks, and `wip poll due` tells whatever schedules them
(the coordinator, cron, CI) which are due:

```wip-flow
polling:
  - name: waiting
    phases: [waiting]   # checks the open items in these phases; leave it out for a flow-wide pass (discovery)
    agent: fast         # the agent that does the check: <defs>/agents/fast.md must exist
    cadence: 1h         # 30m, 1h, 2d
```

```sh
wip poll due [--flow F]                                     # one line per poll
wip poll record review waiting --result "no answer"         # a pass was made (items default to the ones due)
wip poll seen review waiting "#123" --until +2h --note "postponed"   # do not propose it again until then
wip poll seen review waiting                                # the active keys (--all: also the expired)
```

| Status    | Meaning                                                                                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IDLE`    | no open item in its phases (a poll without phases always applies)                                                                                                                |
| `OK`      | the last pass is younger than the cadence                                                                                                                                        |
| `DUE`     | the cadence passed (or it never ran)                                                                                                                                             |
| `OVERDUE` | due and unattended for more than 1.5 cadences, counted from the later of the last pass and the moment its items entered the phase: the scheduler missed it, it was not just idle |

`wip poll due` always exits 0: it is a report. A scheduler reads `--json` (`data.polls[]` with `status`, `due`,
`overdue`, `last_run`, `next_at`, `items` with their `last_seen`, and the `seen` keys), for example from cron or CI:

```sh
wip poll due --json | jq -r '.data.polls[] | select(.due) | "\(.flow)/\(.poll) \(.agent)"'
```

A pass is not an item event: it never touches an item's history nor its `waiting_on`; what it finds is recorded with
the usual commands. `wip check` warns with `poll_overdue` (exit code unchanged) and `wip web` shows the last and next
pass in its footer. Polling adds schema 2 to the database: any command migrates a schema 1 one, and an older
`wip` then refuses it (exit 10). `wip web` migrates it when it starts; restart a running `wip web` after upgrading.

A pass at a fixed time (every Monday at 09:00, say) is a cron: `wip cron add --poll <flow>/<poll>` (see [Cron](cron.md)).
The `polling` block belongs to a flow: see [Flows](flows.md). The command table is in [Commands](commands.md).
