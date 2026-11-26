# wip-quiet

A quieter transcript in Claude Code. The mod gives each transcript category a mode: `show` draws every row
in full, `hide` leaves no trace, and `fold` draws one clickable line (`▸ <label>`) that unfolds into the whole
row. By default every category is folded except `errors`, which is shown whole. `/wip-quiet` changes the modes.

The mod changes what is drawn only. The stored transcript and what the model reads are untouched, and so are
permissions: a hidden tool call still runs, and a hidden result still reaches the model.

## Categories and defaults

| Category       | Rows                                                    | Default |
| -------------- | ------------------------------------------------------- | ------- |
| `bash`         | `Bash`, `BashOutput`, `KillShell`                       | `fold`  |
| `agent`        | `Agent`, `Task`                                         | `fold`  |
| `cron`         | any tool whose name starts with `Cron`                  | `fold`  |
| `files`        | `Read`, `Write`, `Edit`, `NotebookEdit`, `Glob`, `Grep` | `fold`  |
| `msg`          | `SendMessage`                                           | `fold`  |
| `mcp`          | any `mcp__*` tool                                       | `fold`  |
| `misc`         | every other tool                                        | `fold`  |
| `errors`       | any tool row that failed or was interrupted             | `show`  |
| `group`        | a run of tool calls folded into a group                 | `fold`  |
| `turn`         | the turn duration                                       | `fold`  |
| `peer`         | user messages from a peer, a coordinator or an observer | `fold`  |
| `tasknote`     | task notifications                                      | `fold`  |
| `cronfire`     | scheduled triggers                                      | `fold`  |
| `toolprogress` | the background pill's hint                              | `fold`  |
| `notice`       | info notices                                            | `fold`  |

`show` draws the row whole, `hide` draws nothing, and `fold` draws one plain, dim line: `▸ Bash`,
`▸ 4 calls · Read, Grep, Bash…`, `▸ turn · Baked`, `▸ peer message · <preview>`, `▸ background hint`,
`▸ info notice · <preview>`. A click unfolds it (`▾`) and a second click folds it back; the unfolded row is
the engine's own. A preview is the first non-empty line of the text, trimmed and with its whitespace collapsed,
cut to 59 characters plus `…`.

Questions to the person (`AskUserQuestion`, `ExitPlanMode`), the assistant's text, command output and the
person's own typed or Remote-Control messages always stay visible. `ctrl+o` and `--verbose` draw every row in
full whatever its mode, for the rows that carry `isExpanded` (tool calls and results, groups, messages, the turn
duration); notices and background hints have no `isExpanded`, so their mode applies in every view.

A `ToolGroup` whose calls include a category in `show` always draws the engine's group line: a shown call never
disappears behind the group's mode. Unfolding a group asks the engine to expand it, and each per-call row then
obeys its own category.

## No persistent display

The mod draws nothing while it works: no band, badge, status line or pane, and it never shows the current
configuration. Run `/wip-quiet status` to see it; the only drawings are the modes' rows, the message times
(default on; `/wip-quiet time off`) and the transient error toast.

## `/wip-quiet`

The command takes one verb:

| Verb                   | What it does                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `status` (or nothing)  | on/off, message times, the session counter, errors not reviewed, then one line per category        |
| `on` / `off`           | applies the modes / draws everything; `off` keeps the modes stored and stops counting and toasting |
| `show <cat…\|all>`     | draws those categories in full; several names at once, `all` for every one                         |
| `hide <cat…\|all>`     | leaves no trace of those categories                                                                |
| `fold <cat…\|all>`     | one line per row of those categories, a click to unfold                                            |
| `time on` / `time off` | draws (or stops drawing) the send time under each message; `HH:MM YYYY-MM-DD` in Europe/Madrid     |
| `ack`                  | resets the error counter                                                                           |

`show`, `hide` and `fold` answer `Shown: bash, files`, `Hidden: bash`, `Folded: bash`, or `Shown: all` and its
kin. With no category, an unknown category or an unknown verb they answer the usage and change nothing; the old
`show hidden` and `hide hidden` are gone, and the usage names `fold` in their place.

`show all` writes `show` into every mode and survives a restart; `off` is not that: it suspends the modes without
changing them, so `on` restores the look you had.

A failed tool call whose `errors` mode is `fold` or `hide` raises one transient toast naming the tool, the mode
and the first line of the reason: `⚠ Bash failed (folded row): <reason>`. With the default `errors: show` the row
is drawn whole, nothing is counted and nothing toasts. The counter appears only in `status` and is reset by
`ack`.

The status block is:

```text
wip-quiet: on
message times: on
rows folded or hidden this session: none
errors not reviewed: 0
bash: fold
agent: fold
cron: fold
files: fold
msg: fold
mcp: fold
misc: fold
errors: show
group: fold
turn: fold
peer: fold
tasknote: fold
cronfire: fold
toolprogress: fold
notice: fold
```

`off` prints `wip-quiet: off` and still lists the modes, which is what `on` will apply.

## Stored choices and migration

The choices live in the mod's own store under `prefs`, as `{ "version": 2, "enabled", "modes", "timestamps" }`,
and come back at the next session. A command that changes something writes version 2.

A `prefs` written by an older release (`hidden` + `showHidden`, no `version`) is migrated when it is read, and
nothing is written until a command changes something:

- the old default (every category hidden, no folded line) is indistinguishable from "no choice" and gets the new
  defaults: every category folded, `errors` shown;
- any other old value is mapped faithfully: a hidden category becomes `fold` when the folded line was on and
  `hide` otherwise; a visible one becomes `show`. The categories left at the old default keep the old no-trace
  look until you run `fold all`;
- a corrupt or partial `prefs` never throws: each field that is missing or of the wrong type keeps its default,
  and a partial `modes` map fills the rest from the defaults.

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
  says `exists` and writes nothing. The stored `prefs` live in the engine's store, outside the copy, so they
  survive the replacement and the mod migrates them when it reads them.
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

`hooks/classify.ts` holds the categories, the modes and their defaults; `hooks/register.tsx` the atoms, the
render hooks, the commands and the prefs migration. `hooks/timestamps.ts` reads the time from the session
transcript with `grep`, and formats it for Europe/Madrid by the EU summer-time rule; it has no timezone option.

## Licence

MIT. See `LICENSE`.
