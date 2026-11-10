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
| `<defs>/skills/wip-flow-tasks/`                  | the default flow, `tasks`, in three stages: preparation, execution and review (see [Flows](flows.md))                                                                                                                                                                                                                                                                                                  |

It never overwrites: a second run says `exists` for each file and changes nothing. `--force` rewrites the files that
carry a `wip:` mark in their frontmatter (every file `wip init` writes), copying each one first to
`.wip/backups/defs/`, and keeps the `model:` line of the generic agents and the coordinator; any other edit stays
only in the backup. A file at one of those paths without a `wip:` mark is another tool's: `wip init` exits 3 without
writing anything and names it, also with `--force`.

`wip init` also creates the items a flow lists under `seed` in its block, and copies each seed's `files` from the
flow's skill folder into the item's artifact directory. The `tasks` flow seeds one, `onboarding` («Get to know wip»),
in `intake` and waiting on you, with the artifact `guide.md`: everything you can do with wip, the kanban included.
On the first start the coordinator only tells you, in its `🟪 NEXT` line, that you have an onboarding task. When
you want to start, it gives you the links to the guide (`view/item/tasks/onboarding/artifact/guide.md` on the
kanban) and to the item's panel, answers your questions from the guide, and closes the item at a real gate («Close
the onboarding?») in `done`, archived. An ID that already exists, open or archived, is never touched: a second init
or `--force` neither duplicates nor revives it, nor rewrites its files.

A project keeps its definitions folder. An init that would write another folder of the same scope (a legacy
`.agents/` or `~/.agents/`) exits 3 and writes nothing, and its message says to add `--force`. With `--force` it
writes the templates into `.claude/`, switches `.wip/config.json` to it and prints a `switched` line; the old folder is
not touched, moved or deleted, and wip stops reading it. Init warns (`defs_left_behind`) about the custom agents and
skills of the old folder that it does not copy: copy them by hand if you need them. It refuses (exit 3, nothing
written) when a live item uses a flow that the new folder lacks: copy that flow's folder by hand and run init again.
Local and `--global` are never switched, also with `--force`.

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
`.wip/backups/defs/` of the project you ran it from. The rules about files without a `wip:` mark and about other tools'
files in the folder are the same. A project is either local or global and wip never mixes the two folders nor switches
one scope to the other (`--global` on a local project, or the reverse, exits 3 and says which command to run, also
with `--force`); within a scope, `--force` switches the folder as described above. Whoever
clones the repository needs their own `wip init` (with or without `--global`).

## The Kanban mod: `--kanban`

`wip init` can install an optional, read-only Kanban for Claude Code: a pane listing the project's open wip items. An
installed copy lives in `.claude/skills/wip-kanban/`, always in the project, also with `--global` (that flag decides
where the agents and skills live, never where this copy does). It is a self-contained copy of `mods/wip-kanban/`,
embedded in the npm package and the standalone binary, so installing needs no network and no extra download. A new
Claude Code session, terminal or desktop, loads it by itself as `wip-kanban@skills-dir`, with no `--plugin-dir` and no
marketplace.

The install writes two things: that copy, and `"enabledPlugins": {"wip-kanban@skills-dir": true}` merged into one
settings file of the project. In a terminal the wizard's fourth step asks `Install the wip Kanban mod for Claude
Code?` (`yes`, the default, installs the copy and the entry; `no` writes nothing) and, after `yes`, `Where does the
enabledPlugins entry go?`:

- `settings.json`, the default: `.claude/settings.json`, Claude's project scope, shared with the repository;
- `settings.local.json`: `.claude/settings.local.json`, Claude's local scope, personal to this clone, normally not
  versioned, and applied by Claude over the project file for the same plugin id.

Without a terminal:

```sh
wip init --yes
wip init --yes --force
wip init --yes --kanban --kanban-settings-file settings.local.json
```

`--yes` takes the wizard's default answers, the Kanban step included: it installs the copy and writes the entry in
`.claude/settings.json` (or in the file that already holds it), so `wip init --yes` and `wip init --force --yes`
install the mod. The default is still `no` when the entry is explicitly `false`, when a folder that is another tool's
sits at the mod's path or when the settings cannot take the entry; `--kanban` installs anyway (it reactivates a
`false` with a backup, and exits 3 with a foreign folder). `--kanban-settings-file
settings.json|settings.local.json` chooses the file and is only valid together with `--kanban` (else exit 2, nothing
written). A script that wants the old behaviour (no mod) omits `--yes` and passes `--start-default` to keep the
default start without a terminal.
`--kanban` skips the wizard's first question and still asks the file; `--kanban --force` skips both and writes the
default `.claude/settings.json`; `--kanban-settings-file` skips the second. The
merge preserves every other key, every other plugin and their order, adds `$schema` only when it creates the file,
and copies the previous text to `.wip/backups/claude-settings/<file>.<stamp>` before changing it. Init never writes
the other settings file: it reads it only to warn when its entry wins over the chosen one
(`kanban_settings_overridden`), disagrees with it (`kanban_settings_duplicate`) or cannot be read
(`kanban_settings_unreadable`). A warning never changes the exit code. An invalid JSON, an `enabledPlugins` that is
not an object, a non-boolean value or a file that is not a regular file in the chosen path exits 3 with nothing
written.

Updating the copy is part of init: with `--force` the whole folder is replaced, managed files return to the embedded
text, your own extra files inside it are removed (each listed as `removed`) and the previous folder is copied first to
`.wip/backups/kanban/wip-kanban.<stamp>/`; the `.claude-plugin/types/` Claude generates is kept. A second `--force`
with nothing changed says `exists` and writes nothing. `--force` alone refreshes an existing copy and touches neither
settings file; `--yes` installs the entry with the wizard's defaults; only `--kanban` reactivates a `false`, writing
`true` in the chosen file with a backup. A folder at that path without wip's `.claude-plugin/wip.json` mark, or a
file or link there, is another tool's: exit 3 with nothing written, also with `--force`.

`wip state --json` also carries the model the pane and the web share: `data.board.flows`, every flow with its declared
phases and its columns, each with the stage colour as `rgba()` and as the two solid colours and contrasting texts the
terminal paints. The field is additive: `data.items` and its filters keep their meaning, and the web page is unchanged.

Development keeps using the checkout directly, `claude --plugin-dir /path/to/wip/mods/wip-kanban` (or
`CLAUDE_CODE_PLUGIN_DIRS` for desktop), and must not run at the same time as an installed `skills-dir` copy in one
session: both register `/wip-kanban` and the pane. `wip start` and the rest of wip are unchanged.

The pane's use, its configuration, and how to update, disable or remove the mod are in the mod's own reference,
[`mods/wip-kanban/README.md`](../mods/wip-kanban/README.md).

See [Install](install.md) for installing wip and [Start the coordinator: `wip start`](start.md) for the next step.
