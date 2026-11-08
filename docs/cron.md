# Cron

[← Back to the README](../README.md)

`wip cron` keeps a list of scheduled jobs in the project: free-text reminders and fixed-time passes of a flow poll,
once or repeating. wip never fires them: at the start of every session the coordinator reads `wip cron list --json`
and arms each job in its runtime (Claude Code: a one-shot `CronCreate`), so it fires during the session; what came
due while no session was open shows at the next start.

```sh
wip cron add "llamar a X" --at "2026-11-06 14:00"                  # a reminder, local time
wip cron add "weekly review" --at "2026-11-06 14:00" --every 7d    # every Friday 14:00, also across DST
wip cron add "check the PR" --at +90m --item T12                  # tied to an open item
wip cron add --poll tasks/pr-review --at "2026-11-09 09:00" --every 7d   # a fixed-time pass of a declared poll
wip cron list [--all] [--horizon 7d]                              # open jobs and the next pass of each flow poll
wip cron done c3                                                  # one-off: done · repeating: the next occurrence after now
wip cron cancel c3
wip cron snooze c3 --at +1d
```

`--at` takes a UTC ISO time (`2026-11-06T13:00:00Z`), an ISO time with an offset (`2026-11-06T14:00+01:00`), a local
`YYYY-MM-DD HH:MM` in the machine's time zone (a time a DST change skips is refused) or `+<N>m`, `+<N>h`, `+<N>d`; a
time that is not in the future exits 2. `--every` is a cadence counted from `--at` (`30m`, `1h`, `7d`); `d` moves
local calendar days. `--item` must name an open item (archived: exit 3, unknown: exit 4); `--poll` a poll of an
active flow (exit 4 otherwise). `done`, `cancel` and `snooze` on a closed cron exit 3.

`wip cron list --json` returns `data` with `now`, `session` (the open session), `horizon_end`, `beyond` (open jobs
after the horizon), `rearm` (when to read again, if `beyond` > 0) and `jobs[]`, sorted by time. Each job has a `key`
that stays the same while nothing changes (`cron:c3@<at>` or `poll:<flow>/<poll>@<next_at>`), `kind`
(`reminder`|`poll`), `source` (`cron`|`flow`), `id`, `status`, `at`, `at_local`, `cron` (a 5-field expression for
that local minute), `due` (from 2 minutes before `at`), `missed` (due before the open session started), `every`,
`text`, `item`, `flow`, `poll`, `agent` and, for a poll, `pass` (its `wip poll due` row). `wip poll` does not change.

**A reminder, not an alarm:** nothing fires with no session open or in the middle of a turn; a due reminder shows at
the next start, or when the session is idle again.

**Schema 4, one way.** `wip cron` adds schema 4 (`crons`) to the database: the first command of this version in a
project migrates it, after copying it to `.wip/backups/db/wip.sqlite.v3.<time>.<pid>`, and every older `wip` then
refuses the project with exit 10. Update every wip binary that opens this project (the pinned `wip_bin`, shell
aliases, a running `wip web`) before or right after the first run.

The declared polls are in [Polling](polling.md); the flows that declare them are in [Flows](flows.md).
