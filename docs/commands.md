# The commands

[← Back to the README](../README.md)

| Command                                         | What                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `wip init`                                      | create `.wip/` and the definitions                                             |
| `wip upgrade [--check\|--dry-run]`              | update the npm CLI and the project's Kanban mod (exit 1 on `--check` findings) |
| `wip start`                                     | run the coordinator: the start command saved in `.wip/config.json`             |
| `wip phase <ID> <phase> [--flow F]`             | create an item, or move it along its flow's `next` or to a `from_any` phase    |
| `wip set <ID> key=value …`                      | set fields (`int +N`, `list +a/-a`, `ts now/none/ISO 8601`)                    |
| `wip wait <ID> user\|external\|none\|agent:<a>` | record who the item waits on                                                   |
| `wip agent start\|stop <ID> …`                  | record a subagent run                                                          |
| `wip gate open\|close <ID> …`                   | open or close a decision for the user                                          |
| `wip log <ID> "<text>"`                         | add a note to the item's history                                               |
| `wip show <ID>`                                 | one item with its runs, gates, history and totals (clock and work time)        |
| `wip state [--attention]`                       | every item and what it waits on                                                |
| `wip archive <ID> [--no-prune]`                 | archive an item with nothing running nor open; prunes its folder to the trash  |
| `wip prune <ID>\|--archived [--dry-run]`        | move an archived item's dependencies, builds and `tmp/` scratch to the trash   |
| `wip session start`                             | a coordinator (re)starts: runs left running become `orphaned`                  |
| `wip check [<ID>]`                              | the invariants (exit 1 on findings) and the warnings                           |
| `wip flow lint [<flow>]`                        | validate the flows; lists the disabled ones as `DISABLED <flow>`               |
| `wip flow disable\|enable <flow>`               | hide a flow and freeze its items, or bring it back                             |
| `wip flow order [<flow> …\|--reset]`            | choose the order of the flows on the board (`.wip/config.json`)                |
| `wip poll due\|record\|seen`                    | the flows' scheduled checks: what is due, record a pass, what a pass saw       |
| `wip cron add\|list\|done\|cancel\|snooze`      | scheduled reminders and fixed-time poll passes, kept across sessions           |
| `wip web [status\|stop\|log]`                   | the kanban: serve it, check it, stop it, read its log                          |

Every command accepts `--json` (envelope `{ok, item, events, warnings, message, data}`) and `--help`. Exit codes:
0 ok · 1 findings · 2 usage · 3 rejected · 4 not found (or no `.wip/`) · 10 database. `WIP_HOME` points the CLI at
another project, only if that directory contains a `.wip/`. `wip upgrade --json` adds `data.changelog`, the release
notes of the installed version or `null` (see [`wip upgrade`](upgrade.md#whats-new)).

Each group has its own page: [`wip init`](init.md), [`wip upgrade`](upgrade.md), [`wip start`](start.md),
[Flows](flows.md), [`wip prune`](prune.md), [`wip web`](web.md), [Polling](polling.md) and [Cron](cron.md).
