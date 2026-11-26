# Start a project: `wip init`

[← Back to the README](../README.md)

```sh
cd my-project
wip init                          # definitions in .claude/; or: wip init <path>
wip init --global                 # definitions in ~/.claude/, shared by every --global project
```

`wip init` creates, with `<defs>` being `.claude`:

| Path                                             | What                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.wip/`                                          | the state; added to `.gitignore`                                                                                                                                                                                                                                                                                                                                                                       |
| `.wip/config.json`                               | `defs_dir` (the definitions folder) and optional `wip_bin` (path of the `wip` binary the coordinator runs, to pin a version per project; `wip start` records the path it was started as and exports it as `WIP_BIN`), plus optional `flow_order` (the order of the flows on the board, see [Flows](flows.md#the-order-of-the-flows-on-the-board)); every command reads the definitions from `defs_dir` |
| `<defs>/agents/wip.md`                           | the coordinator: the only agent that talks to you                                                                                                                                                                                                                                                                                                                                                      |
| `<defs>/agents/{fast,efficient,thinker,wise}.md` | the four generic subagents                                                                                                                                                                                                                                                                                                                                                                             |
| `<defs>/skills/wip-coordinate/`                  | how the coordinator runs a flow: cycle, launch prompt, gates, agent choice, changing a model, runtime interface                                                                                                                                                                                                                                                                                        |
| `<defs>/skills/wip-new-flow/` · `wip-new-agent/` | how the coordinator creates or changes a flow or an agent; `wip-new-flow/example.md` is a reference flow                                                                                                                                                                                                                                                                                               |
| `<defs>/skills/wip-subagent-protocol/`           | the contract every subagent follows; the coordinator never applies it to itself                                                                                                                                                                                                                                                                                                                        |
| `<defs>/skills/wip-flow-development/`            | the `development` flow: a small piece of work in a worktree and branch, with a plan, a build, QA, the user's review, one commit and one release (see [Flows](flows.md))                                                                                                                                                                                                                                |
| `<defs>/skills/wip-flow-ideas/`                  | the `ideas` flow: shapes an idea in rounds of questions and answers before anything is built                                                                                                                                                                                                                                                                                                           |
| `<defs>/skills/wip-flow-reports/`                | the `reports` flow: a search or a report, one-off or recurring, from the questions and sources to the written report                                                                                                                                                                                                                                                                                   |
| `<defs>/skills/wip-flow-tasks/`                  | the `tasks` flow: any task with a clear outcome, one-off or recurring, in four phases (`todo`, `doing`, `done` and `closed`); it seeds `onboarding`                                                                                                                                                                                                                                                    |

These four flows are the default set. In a terminal the wizard has seven steps: scope, the flows to write, the start
command, what goes into `.gitignore`, the Kanban mod, the Quiet mod and the seventh step, Settings, where the
`enabledPlugins` entry goes (one answer for both mods; with no mod installed it says so and asks nothing). The Flows
step shows all four checked; Space toggles one, Enter confirms and at least one stays checked. `--flows development,ideas,reports,tasks` selects a subset for scripts
(trimmed, duplicates removed, only names init ships; an unknown or empty value exits 2 and writes nothing), and
`--yes` without `--flows` writes all four. A run only adds the selected flows: it never deletes a deselected or custom
flow.

It never overwrites: a second run says `exists` for each file and changes nothing. `--force` rewrites the files that
carry a `wip:` mark in their frontmatter (every file `wip init` writes), copying each one first to
`.wip/backups/defs/`, and keeps the `model:` line of the generic agents and the coordinator; any other edit stays
only in the backup. A file at one of those paths without a `wip:` mark is another tool's: `wip init` exits 3 without
writing anything and names it, also with `--force`. A normal [`wip upgrade`](upgrade.md) asks before writing them in a
terminal, and `wip upgrade --apply-defs` does the same with the same writer, backups and `model:` preservation but no
seeding of items, no unselected flow, no `defs_dir` switch and no `.gitignore` change: it applies the templates of the
running build to the folder in place, and `wip upgrade` says first whether `--force` would change anything.

When the wizard's answers would be refused for lack of `--force`, it says so after `Write?`: it prints in red the
reasons and the files `--force` would replace (or that it would replace none), and asks `Apply --force and replace
them?` and `Confirm again: apply --force?`, both `y/N`, so Enter declines. A no prints `nothing written` and exits 3
without writing anything; two yes answers append `--force` and the run goes on, backing each replaced file up under
`.wip/backups/` first. This offer is wizard-only: `--yes`, `--json` and a run without a terminal keep exit 3 with
the same message.

`wip init` also creates the items a flow lists under `seed` in its block, and copies each seed's `files` from the
flow's skill folder into the item's artifact directory. The `tasks` flow, when the run writes it, seeds one,
`onboarding` («Get to know wip»), in `todo` and waiting on you, with the artifact `guide.md`: everything you can do
with wip, the kanban included; a project initialised without `tasks` has no onboarding item. On the first start the
coordinator tells you, in its `🟪 NEXT` line, that you have an onboarding task, and adds one line that the flows and
agents are yours to change (edit one, disable one you do not use, create one by asking). When you want to start, it
gives you the links to the guide (`view/item/tasks/onboarding/artifact/guide.md` on the kanban) and to the item's
panel, answers your questions from the guide (its «Your own flows and agents» section says how to change them), and
closes the item at a real gate («Close the onboarding?») in `closed`, archived. An ID that already exists, open or archived, is never touched: a second init
or `--force` neither duplicates nor revives it, nor rewrites its files.

A project keeps its definitions folder. An init that would write another folder of the same scope (a legacy
`.agents/` or `~/.agents/`) exits 3 and writes nothing, and its message says to add `--force`. With `--force` it
writes the templates into `.claude/`, switches `.wip/config.json` to it and prints a `switched` line; the old folder is
not touched, moved or deleted, and wip stops reading it. Init warns (`defs_left_behind`) about the agents and skills
of the old folder that it does not copy, a shipped flow that this run does not select included: add it back with
`--flows` or copy it by hand if you need it. It refuses (exit 3, nothing written) when a live item uses a flow that
the new folder lacks: add that shipped flow to `--flows` or copy its folder by hand, and run init again.
Local and `--global` are never switched, also with `--force`. In a terminal the wizard offers `--force` after
`Write?` for this switch, with the same two confirmations.

## `--gitignore`

`wip init --gitignore wip,defs | none` chooses what goes into `.gitignore`: `wip` adds `.wip/` (the default, also with
`--yes` and without a terminal), `defs` adds the paths of the wip templates in the definitions folder (not the folder; files
git already tracks stay tracked; ignored with `--global`), `none` touches nothing. `.wip/` holds `wip.db`, logs and a
`config.json` with the local `wip_bin`, so versioning it is not recommended; to keep the plans, ignore `.wip/*` and add
`!.wip/items/` by hand.

## `--global`

`wip init --global` writes the definitions into your home folder, `~/.claude/`, instead of the project, so the
repository carries no agents or skills. `.wip/`, its config, the
`.gitignore` entry and the seeded items still go in the project. The output of `wip init` names the folder it wrote
to in full (`/Users/you/.claude/agents/fast.md`), resolved from `HOME`. `.wip/config.json` keeps `defs_dir` as `~/.claude` and
every command resolves it against the home folder of whoever runs it (`HOME`, or `USERPROFILE` on Windows; without
either, exit 3). The definitions are one copy shared by every project initialised with `--global`: the second project
says `exists` on each file, and `wip init --global --force` from any project refreshes them for all, with the backup in
`.wip/backups/defs/` of the project you ran it from. `wip upgrade` writes that shared folder too when you accept its
question (or with `--apply-defs`), also in place and with the backup in the running project. The rules about files
without a `wip:` mark and about other tools' files in the folder are the same. A project is either local or global and
wip never mixes the two folders nor switches
one scope to the other (`--global` on a local project, or the reverse, exits 3 and says which command to run, also
with `--force`); within a scope, `--force` switches the folder as described above. Whoever
clones the repository needs their own `wip init` (with or without `--global`).

## The mods: `--kanban` and `--quiet`

`wip init` can install two optional mods for Claude Code:

- **Kanban** (`--kanban`): a read-only pane listing the project's open wip items.
- **Quiet** (`--quiet`): a quieter transcript that folds, hides or shows each row category, with `/wip-quiet` to
  choose; every row it touches is neither the assistant's text nor the person's own messages.

An installed copy lives in `.claude/skills/wip-kanban/` or `.claude/skills/wip-quiet/`, always in the project, also
with `--global` (that flag decides where the agents and skills live, never where these copies do). Each is a
self-contained copy of its folder under `mods/`, embedded in the npm package and the standalone binary, so installing
needs no network and no extra download. A new Claude Code session, terminal or desktop, loads them by themselves as
`wip-kanban@skills-dir` and `wip-quiet@skills-dir`, with no `--plugin-dir` and no marketplace.

Each install writes its copy and one `"enabledPlugins"` entry, merged into the **same** settings file. The wizard's
fifth step asks `Install the wip Kanban mod for Claude Code?` and its sixth `Install the wip Quiet mod for Claude
Code?` (both default to `yes`: Enter installs the copy and the entry; `no` writes neither). After them, the seventh
step asks `Where does the enabledPlugins entry go?` **once per run**, and that one answer serves both mods:

- `settings.json`, the default: `.claude/settings.json`, Claude's project scope, shared with the repository;
- `settings.local.json`: `.claude/settings.local.json`, Claude's local scope, personal to this clone, normally not
  versioned, and applied by Claude over the project file for the same plugin id.

Without a terminal:

```sh
wip init --yes
wip init --yes --force
wip init --yes --mods-settings-file settings.local.json
```

`--yes` takes the wizard's default answers, both mod steps included: it installs both copies and writes both entries
in `.claude/settings.json` (or in the file that already holds them), so `wip init --yes` and `wip init --force --yes`
install both mods. A mod's default is `no` when its entry is explicitly `false`, when a folder that is another tool's
sits at its path or when the settings cannot take the entry; `--kanban` or `--quiet` installs anyway (reactivating a
`false` with a backup, and exiting 3 with a foreign folder). `--mods-settings-file
settings.json|settings.local.json` chooses the one file both mods use; it goes with `--kanban`, `--quiet` or `--yes`
(else exit 2, nothing written). `--kanban-settings-file` is the deprecated alias: it keeps its old rule (only with
`--kanban`) and selects the file for both mods, and when both flags are given `--mods-settings-file` wins and the
alias is ignored. A script that wants no mods omits `--yes` and passes `--start-default` to keep the default start
without a terminal.

`--kanban`/`--quiet` skip their own install question; `--kanban --force` also skips the file question and writes the
default `.claude/settings.json`; `--mods-settings-file` skips it too. The merge preserves every other key, every other
plugin and their order, adds `$schema` only when it creates the file, writes the file **once** for both entries and
copies the previous text to `.wip/backups/claude-settings/<file>.<stamp>` before changing it. Init never writes the
other settings file: it reads it only to warn when an entry wins over the chosen one
(`kanban_settings_overridden`, `quiet_settings_overridden`), disagrees with it (`kanban_settings_duplicate`,
`quiet_settings_duplicate`) or cannot be read (`kanban_settings_unreadable`, `quiet_settings_unreadable`). A warning
never changes the exit code. An invalid JSON, an `enabledPlugins` that is not an object, a non-boolean value or a file
that is not a regular file in the chosen path exits 3 with nothing written.

Updating the copies is also what [`wip upgrade`](upgrade.md) does, with the installed CLI's own embedded files and
only in the current project; `wip init --force` remains the broader refresh, because it also writes the definitions
and, with `--kanban` or `--quiet`, the settings. Init replaces a whole folder with `--force`: managed files return to
the embedded text, your own extra files inside it are removed (each listed as `removed`) and the previous folder is
copied first to `.wip/backups/kanban/wip-kanban.<stamp>/` or `.wip/backups/quiet/wip-quiet.<stamp>/`; the
`.claude-plugin/types/` Claude generates is kept. A second `--force` with nothing changed says `exists` and writes
nothing. `--force` alone refreshes an existing copy and touches neither settings file; `--yes` installs the entries
with the wizard's defaults; only `--kanban` or `--quiet` reactivates a `false`, writing `true` in the chosen file with
a backup. A folder at that path without wip's `.claude-plugin/wip.json` mark, or a file or link there, is another
tool's: exit 3 with nothing written, also with `--force`.

`wip state --json` also carries the model the Kanban pane and the web share: `data.board.flows`, every flow with its
declared phases and its columns, each with the stage colour as `rgba()` and as the two solid colours and contrasting
texts the terminal paints. The field is additive: `data.items` and its filters keep their meaning, and the web page is
unchanged.

Development keeps using the checkout directly, `claude --plugin-dir /path/to/wip/mods/wip-kanban` (or
`/path/to/wip/mods/wip-quiet`, and `CLAUDE_CODE_PLUGIN_DIRS` for desktop), and must not run at the same time as an
installed `skills-dir` copy in one session: both register the same command (`/wip-kanban` or `/wip-quiet`) and the
same pane or rows. `wip start` and the rest of wip are unchanged.

Each mod's use, its configuration, and how to update, disable or remove it are in its own reference:
[`mods/wip-kanban/README.md`](../mods/wip-kanban/README.md) and [`mods/wip-quiet/README.md`](../mods/wip-quiet/README.md).

See [Install](install.md) for installing wip and [Start the coordinator: `wip start`](start.md) for the next step.
