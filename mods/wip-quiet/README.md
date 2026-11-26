# wip-quiet

A quieter transcript in Claude Code. The mod hides the rows that are neither the assistant's text nor the
person's own messages: tool calls and their results, tool groups, the turn duration, info notices, background
pills, and the user messages a peer, a task notification or a scheduled trigger writes. `/wip-quiet` shows them
again on demand.

The mod changes what is drawn only. The stored transcript and what the model reads are untouched, and so are
permissions: a hidden tool call still runs, and a hidden result still reaches the model.

## What it hides

Every hidden row belongs to a category; all of them are hidden at the start.

| Category       | Rows                                                    |
| -------------- | ------------------------------------------------------- |
| `bash`         | `Bash`, `BashOutput`, `KillShell`                       |
| `agent`        | `Agent`, `Task`                                         |
| `cron`         | any tool whose name starts with `Cron`                  |
| `files`        | `Read`, `Write`, `Edit`, `NotebookEdit`, `Glob`, `Grep` |
| `msg`          | `SendMessage`                                           |
| `mcp`          | any `mcp__*` tool                                       |
| `misc`         | every other tool                                        |
| `errors`       | any tool row that failed or was interrupted             |
| `group`        | a group whose calls are all hidden                      |
| `turn`         | the turn duration                                       |
| `peer`         | user messages from a peer, a coordinator or an observer |
| `tasknote`     | task notifications                                      |
| `cronfire`     | scheduled triggers                                      |
| `toolprogress` | the background pill's hint                              |
| `notice`       | info notices                                            |

Questions to the person (`AskUserQuestion`, `ExitPlanMode`), the assistant's text, command output and the
person's own typed or Remote-Control messages always stay visible. `ctrl+o` on a message still expands it in
full.

## No persistent display

The mod draws nothing while it works: no band, badge, status line or pane, and it never shows the current
configuration. Run `/wip-quiet status` to see it; the only drawings are the hidden rows themselves, the folded
lines after `/wip-quiet show hidden`, the message times (default on; `/wip-quiet time off`) and the transient
hidden-error toast.

## `/wip-quiet`

The command takes one verb:

| Verb                                    | What it does                                                                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status` (or nothing)                   | the configuration: on/off, hidden and folded modes, message times, hidden and visible categories, rows hidden this session and errors not reviewed |
| `on` / `off`                            | hides the selected categories again / draws everything                                                                                             |
| `show <cat…\|all>` / `hide <cat…\|all>` | makes categories visible or hidden; several names at once, `all` for every one                                                                     |
| `show hidden` / `hide hidden`           | each hidden call becomes a folded `▸ <tool>` line that a click unfolds; `hide hidden` leaves no trace                                              |
| `time on` / `time off`                  | draws (or stops drawing) the send time under each message; the time is `HH:MM YYYY-MM-DD` in Europe/Madrid                                         |
| `ack`                                   | resets the hidden-error counter                                                                                                                    |

A failed hidden tool call raises a transient toast naming the tool and the first line of the reason; the count
appears only in `status` and is reset by `ack`.

The choices are stored in the mod's own store and come back at the next session. The categories shown by
`status` are the 15 above; the `prefs` key holds `enabled`, `hidden`, `showHidden` and `timestamps`.

## Install

A third party installs wip as usual and runs `wip init` in the project. The wizard's sixth step asks
`Install the wip Quiet mod for Claude Code?` — `yes` (the default; Enter installs the copy and the entry) or
`no` — and, when the Kanban answer did not already ask it, `Where does the enabledPlugins entry go?`
(`settings.json`, the default, or `settings.local.json`).

Without a terminal:

```sh
wip init --yes
wip init --yes --quiet --mods-settings-file settings.local.json
```

`wip init --yes` takes the wizard's defaults, the Quiet step included: it installs the copy and writes the entry
in `.claude/settings.json` (or in the file that already holds it). The default is `no` when the entry is
explicitly `false`, when another tool's folder sits at the mod's path or when the settings cannot take the entry.
`--quiet` installs anyway; `--mods-settings-file` chooses the file both wip mods use (`--kanban-settings-file`
remains as a deprecated alias). `--global` decides where the wip agents and skills live, never where the mod
lives.

The install is two things:

- a self-contained copy of this mod in `<project>/.claude/skills/wip-quiet/`, which Claude Code loads by itself as
  `wip-quiet@skills-dir` in a new session (no `--plugin-dir`, marketplace or download);
- `"enabledPlugins": {"wip-quiet@skills-dir": true}` merged into the settings file you chose, with every other
  key preserved and a backup in `.wip/backups/claude-settings/`.

A copy in the project is still a project-scope plugin: Claude shows it suppressed until you trust the workspace.
Accept the trust dialog, then run `/reload-plugins` or start a new session.

## Update, disable and remove

- Update after installing a new wip: run `wip upgrade` in the project. It updates the npm CLI and then refreshes
  this copy with the installed CLI's embedded files (by default only a copy wip owns; `--quiet` installs it and
  enables it where missing; `--no-quiet` skips it). `wip init --force` (or `wip init --quiet --force`) remains
  the broader refresh: it also writes the definitions. Either way the whole folder is replaced after copying the
  previous one to `.wip/backups/quiet/wip-quiet.<stamp>/`: managed files go back to the embedded text, your own
  extra files are removed, and the generated `.claude-plugin/types/` is kept. A second run with nothing changed
  says `exists` and writes nothing.
- `--force` without `--quiet` refreshes the copy and touches neither settings file, so a plugin you disabled
  stays disabled. Only `--quiet` writes `true` (with a backup of the settings file).
- Disable without deleting, with the scope of the file that holds the entry:

  ```sh
  claude plugin disable wip-quiet@skills-dir --scope project
  claude plugin enable wip-quiet@skills-dir --scope project
  # or --scope local for .claude/settings.local.json
  ```

  Then `/reload-plugins` or restart. Using the wrong scope does nothing to the other file's entry.
- Remove: delete `.claude/skills/wip-quiet/` and, if you want, the `enabledPlugins` entry from the settings file
  that holds it (`claude plugin uninstall` is for marketplace installs, not `skills-dir` copies). `wip init --quiet`
  installs it again.

## Development

This folder is the source of the mod. From a checkout, run it without installing:

```sh
claude --plugin-dir /path/to/wip/mods/wip-quiet --debug
```

For the desktop app, set `CLAUDE_CODE_PLUGIN_DIRS` to the same folder before starting it. Do not run the
development folder and an installed `skills-dir` copy at once in one session: both register `/wip-quiet`. In a
session that already runs a copy, `/reload-plugins` picks up an edit.

Checks: `claude plugin validate mods/wip-quiet` and `claude plugin test mods/wip-quiet`.

`hooks/timestamps.ts` reads the time from the session transcript with `grep`, and formats it for Europe/Madrid by
the EU summer-time rule; it has no timezone option.

## Licence

MIT. See `LICENSE`.
