# wip

Per-project workflow state for Claude Code.

`wip` is a small CLI that keeps, inside your project, the state of the work an AI coordinator runs on your behalf:
which items exist, which phase of which flow each one is in, which subagent is running, which decision waits on
you. The coordinator, Claude Code, drives it with `wip` commands; you read the result in
the terminal or in a read-only kanban (`wip web`).

- **State** lives in `.wip/` (SQLite, git-ignored), found by walking up from the current directory.
- **Definitions** live in one folder, `.claude/` (versioned), or in your home folder
  with `wip init --global` (`~/.claude/`): `agents/` holds the
  coordinator and four generic subagents; `skills/` holds the coordinator's skills, the subagents' protocol and the
  flows, each flow a skill `wip-flow-<name>`.
- No network, no daemon, no dependencies: one npm package that runs on Node 22.13 or later; for machines without
  Node, a standalone binary can be built from source.

## Install

`@garndev/wip` is not published to the npm registry yet: the first release is pending (see `docs/releasing.md`). Until
then, build the package from this repository ([Development](#development)) and install its tarball the same way.

**Requirements:** Claude Code's `claude` CLI, Node 22.13 or later and npm, on any OS Node supports. Without Node: a
standalone binary you build from this repository (Bun needed for the build only) for `darwin-arm64`, `darwin-x64`,
`linux-x64` (a CPU with AVX2), `linux-arm64` or `windows-x64` (experimental).

### Before installing: is `wip` already taken?

```sh
command -v wip && type wip      # macOS/Linux: prints what `wip` is today (alias, function, file)
Get-Command wip                 # PowerShell
```

If something answers, it is another tool called `wip` (the npm package `wip`, a git alias, a script). Then:

- npm refuses to install a global bin that another global package owns (`EEXIST`): uninstall the other package, or
- install into a prefix of your own and link it under another name, for example
  `npm i -g --prefix ~/.local/wip-npm @garndev/wip`, then `ln -s ~/.local/wip-npm/bin/wip ~/.local/bin/wipx`.
  `wip start` records the path it was started as (`wip_bin`), so the coordinator keeps calling `wipx`.
- A shell alias or function named `wip` hides the installed file: remove it or call the file by its path.

### With npm

```sh
npm install -g @garndev/wip
wip --version              # <version> (<branch> <commit>, built <date>)
cd my-project && wip init  # writes .wip/ and the definitions, see "Start a project"
```

The package holds a JavaScript bundle and the `wip` command, nothing else: no dependencies, no install scripts, no
platform packages. On Node 22 the bundled `node:sqlite` is still flagged experimental; `wip` hides that one warning.

### Without Node: a binary built from source

The GitHub Release carries no binaries. From a clone of this repository, with Bun:

```sh
bun install --frozen-lockfile
bun scripts/build.ts --targets host --out dist    # dist/bin/<os>-<arch>/wip (wip.exe on Windows)
install dist/bin/<os>-<arch>/wip ~/.local/bin/wip
```

`--targets` also takes a list (`darwin-arm64,linux-x64,…`) or `all` to cross-compile for another machine; the
archives and `SHA256SUMS` land in `dist/release/`. The binary needs neither Node nor Bun to run. On macOS it is signed
ad hoc and not notarized: a copy downloaded with a browser gets the quarantine flag, which
`xattr -d com.apple.quarantine <path>` removes. On macOS it uses the system SQLite, which must be 3.37 or later.

### Upgrade

Read the CHANGELOG first, its "Upgrade notes" above all. **An upgrade migrates the database of every project the new
`wip` opens, one way:** the next command in that project upgrades `.wip/wip.sqlite`, and from then on an older `wip`
refuses that project with exit 10. Before migrating, `wip` copies the database as it was to
`.wip/backups/db/wip.sqlite.v<schema>.<time>.<pid>`.

```sh
npm install -g @garndev/wip@latest
wip --version
cd my-project && wip check     # opens (and migrates) the database, reports invariants
```

Switching from the binary to npm, or back, is not a migration: both open the same database. Remove the other `wip`
from `PATH`; a project pinned through `wip_bin` in `.wip/config.json` keeps calling the old path until `wip start`,
started from the new `wip`, rewrites it.

### Back up a project's state by hand

With no `wip` process running in the project (no `wip web`, no coordinator session):

```sh
sqlite3 .wip/wip.sqlite ".backup '.wip/backups/wip.sqlite.$(date +%Y%m%d%H%M%S)'"
# without sqlite3: copy wip.sqlite together with wip.sqlite-wal and wip.sqlite-shm if they exist
```

The item folders (`.wip/items/`) are plain files and are not migrated; the definitions folder is versioned in git
(or lives in `~/.claude` with `--global`).

### Roll back

```sh
npm install -g @garndev/wip@<previous version>
```

Then, in each project the newer version already opened, stop every `wip` process and restore the copy taken before
the migration: `cp .wip/backups/db/wip.sqlite.v<schema>.<time>.<pid> .wip/wip.sqlite` (or your own backup) and delete
`wip.sqlite-wal` and `wip.sqlite-shm`. Changes made after the upgrade are lost on restore; there is no
down-migration.

### Uninstall

```sh
npm uninstall -g @garndev/wip     # a binary: delete the file
```

Project state is not touched: delete `.wip/` per project if you want it gone, and the definitions (`.claude/agents|skills`
files with a `wip:` mark, or `~/.claude/` for `--global`) by hand.

## Start a project: `wip init`

```sh
cd my-project
wip init                          # definitions in .claude/; or: wip init <path>
wip init --global                 # definitions in ~/.claude/, shared by every --global project
```

`wip init` creates, with `<defs>` being `.claude`:

| Path                                             | What                                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.wip/`                                          | the state; added to `.gitignore`                                                                                                                                                                                                                                          |
| `.wip/config.json`                               | `defs_dir` (the definitions folder) and optional `wip_bin` (path of the `wip` binary the coordinator runs, to pin a version per project; `wip start` records the path it was started as and exports it as `WIP_BIN`), every command reads the definitions from `defs_dir` |
| `<defs>/agents/wip.md`                           | the coordinator: the only agent that talks to you                                                                                                                                                                                                                         |
| `<defs>/agents/{fast,efficient,thinker,wise}.md` | the four generic subagents                                                                                                                                                                                                                                                |
| `<defs>/skills/wip-coordinate/`                  | how the coordinator runs a flow: cycle, launch prompt, gates, agent choice, changing a model, runtime interface                                                                                                                                                           |
| `<defs>/skills/wip-new-flow/` · `wip-new-agent/` | how the coordinator creates or changes a flow or an agent; `wip-new-flow/example.md` is a reference flow                                                                                                                                                                  |
| `<defs>/skills/wip-subagent-protocol/`           | the contract every subagent follows; the coordinator never applies it to itself                                                                                                                                                                                           |
| `<defs>/skills/wip-flow-tasks/`                  | the default flow, `tasks`, in three stages: preparation, execution and review (see «Flows»)                                                                                                                                                                               |

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

### `--gitignore`

`wip init --gitignore wip,defs | none` chooses what goes into `.gitignore`: `wip` adds `.wip/` (the default, also with
`--yes` and without a terminal), `defs` adds the paths of the wip templates in the definitions folder (not the folder; files
git already tracks stay tracked; ignored with `--global`), `none` touches nothing. `.wip/` holds `wip.db`, logs and a
`config.json` with the local `wip_bin`, so versioning it is not recommended; to keep the plans, ignore `.wip/*` and add
`!.wip/items/` by hand.

### `--global`

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

### The Kanban mod: `--kanban`

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
wip init --yes --kanban
wip init --yes --kanban --kanban-settings-file settings.local.json
```

`--kanban` installs the copy and writes the entry; `--kanban-settings-file settings.json|settings.local.json` chooses
the file and is only valid together with `--kanban` (else exit 2, nothing written). `--yes` alone installs nothing:
the default `yes` is the wizard's, and a script installs with `--kanban`.
`--kanban` skips the wizard's first question and still asks the file; `--kanban --force` skips both and writes the
default `.claude/settings.json`; `--kanban-settings-file` skips the second. The
merge preserves every other key, every other plugin and their order, adds `$schema` only when it creates the file,
and copies the previous text to `.wip/backups/claude-settings/<file>.<stamp>` before changing it. Init never writes
the other settings file: it reads it only to warn when its entry wins over the chosen one
(`kanban_settings_overridden`), disagrees with it (`kanban_settings_duplicate`) or cannot be read
(`kanban_settings_unreadable`). A warning never changes the exit code. An invalid JSON, an `enabledPlugins` that is
not an object, a non-boolean value or a file that is not a regular file in the chosen path exits 3 with nothing
written.

A copy in the project is project scope: Claude keeps it suppressed until you accept the workspace trust dialog, also
when the entry is in `.claude/settings.local.json`; then run `/reload-plugins` or start a new session. The pane opens
on its own as `wip Kanban`: Claude Code places a pane no one asked for from 144 terminal columns and one the person
opened before from 110; on a narrower terminal the mod opens it on your first prompt, and from then on at launch in
terminals of 110 columns or more. Below 110 columns the engine places no pane, even with `/wip-kanban on`. A copy
installed before this version needs `wip init --force` to get this. `/wip-kanban on` and `/wip-kanban off` open and
close it. The flow filter is a dim row at the bottom right, outside the board: one button per flow
(`✓ <flow>` or `✗ <flow>`, one space apart), the hidden ones are remembered per project, and the board prints no
flow names. Each row is `<id> <phase>`, placed by
the phase's ordinal; a row without attention is painted with its flow's colour at full opacity (the phase's alpha
is not applied), and an item with `signals.attention` takes the stage's solid colour as its background with the
contrasting text. Clicking a row opens `webUrl` with `?item=<flow>/<id>` and the web shows that
item's panel, so the link needs `wip web` running at that URL (the default is the first port it tries, 33333). The
board itself works without the server. `claude plugin configure wip-kanban@skills-dir` sets `webUrl` and
`colorScheme` (`dark`, the default, or `light`; the pane API does not expose the active theme).

`wip state --json` also carries the model the pane and the web share: `data.board.flows`, every flow with its declared
phases and its columns, each with the stage colour as `rgba()` and as the two solid colours and contrasting texts the
terminal paints. The field is additive: `data.items` and its filters keep their meaning, and the web page is unchanged.

Updating: install the new wip and run `wip init --force` (or `wip init --kanban --force`). With `--force` the whole
folder is replaced: managed files return to the embedded text, your own extra files inside it are removed (each listed
as `removed`) and the previous folder is copied first to `.wip/backups/kanban/wip-kanban.<stamp>/`; the
`.claude-plugin/types/` Claude generates is kept. A second `--force` with nothing changed says `exists` and writes
nothing. `--force` without `--kanban` refreshes an existing copy and touches neither settings file, so a plugin you
disabled stays disabled; only `--kanban` writes `true` in the chosen file, with a backup. A folder at that path
without wip's `.claude-plugin/wip.json` mark, or a file or link there, is another tool's: exit 3 with nothing written,
also with `--force`.

Disable the mod without deleting it with `claude plugin disable wip-kanban@skills-dir --scope project` (or
`--scope local` for `.claude/settings.local.json`) and enable it with the same scope; the wrong scope does not reach
the other file's entry. To remove it, delete `.claude/skills/wip-kanban/` and, if you want, the entry from the
settings file that holds it (`claude plugin uninstall` is for marketplace installs only). `wip init --kanban` installs
it again. `--gitignore defs` never ignores the copy, and init does not add it to `.gitignore`: with
`.claude/settings.json`, version the copy with the settings; with `.claude/settings.local.json`, the entry is personal
and each clone decides whether to version the copy or run its own `wip init --kanban`.

Development keeps using the checkout directly, `claude --plugin-dir /path/to/wip/mods/wip-kanban` (or
`CLAUDE_CODE_PLUGIN_DIRS` for desktop), and must not run at the same time as an installed `skills-dir` copy in one
session: both register `/wip-kanban` and the pane. `wip start` and the rest of wip are unchanged.

## Start the coordinator: `wip start`

`wip start` runs, from the project root and in the foreground, the start command saved in `.wip/config.json`: by
default `claude --agent wip --name wip-<stamp>`, which starts the coordinator. Bare `wip` does the same
in a terminal when a project and a command are there; otherwise it prints the help, as `wip help` and `wip --help` do.
`wip start --set -- <command> <arg> …` saves another command (variables `{stamp}`, `{project}`, `{root}`, `{defs}`),
`wip start --dry-run` shows the expanded command and `wip start --unset` goes back to the default.
`wip start` also records in `.wip/config.json` (`wip_bin`) the path it was started as, such as `wip2` from a dev build,
replacing a different value and printing one stderr line; so the coordinator and its subagents run that same binary.
The launched session gets `WIP_BIN` with that path; the coordinator runs it as `wip`.

Claude Code reads agents from `.claude/agents/` and skills from `.claude/skills/`, so the definitions work there
directly, next to other tools' agents and skills; a name clash with a file without the `wip:` mark is exit 3. The
coordinator's `initialPrompt` is the session's first message, so it runs its start protocol at once. The
generic agents preload the protocol skill through their `skills` frontmatter key.

## The four generic agents and their models

`fast`, `efficient`, `thinker` and `wise` share one contract and one body; they differ only in a paragraph about
level, from cheapest to most capable:

- `fast` does exactly what it is told and returns `needs-input` when the task needs a decision;
- `efficient` carries out clear tasks end to end with bounded exploration;
- `thinker` investigates, compares alternatives and justifies its decisions;
- `wise` questions assumptions, looks for risks and edge cases, and is never a default.

Each phase of a flow names its default agent (`agent:`) and what its subagent may write (`writes: artifacts` or
`project`). The coordinator may pick a cheaper or a more capable generic for a given task, and steps up one level
after a failure.

The model of each generic agent and of the coordinator (marked `wip: coordinator`) is its `model:` frontmatter line,
and each template under `templates/agents/` carries one: `haiku` (`fast`), `sonnet` (`efficient`), `opus` (`thinker`),
`fable` (`wise`) and `inherit` (the coordinator). `wip init` writes the template as it is and never asks for or
writes a model; `wip init --yes` fills no `model:` either. In a terminal `wip init` asks in four steps: the scope
(`local`, the default, in the project, or `global`, in your home folder like `--global`; `--global` skips it and an
initialised project keeps its scope, shown as `scope kept`), the `wip start` command, what goes into `.gitignore` and
the Kanban mod (`yes`, the default, or `no`), shows a summary and writes nothing until you confirm (Enter takes the
default, Ctrl+C writes nothing). Colours appear only on a terminal without `NO_COLOR`. `--start '<command>'`,
`--start-default` and `--no-start` answer that one question each. Without a terminal (scripts, CI) init asks nothing
and only `start` can stay unset, as before: `wip check` then reports `start_unset` (exit code unchanged) and the
coordinator mentions it once. A definition edited by hand without a `model:` line is reported by `wip check` as
`models_unset`, and the runtime default model applies meanwhile. Re-running `wip init` never overwrites a saved
`start` unless you answer so, and `--force` keeps the `model:` line a file already had. The definitions folder is
versioned with the project when it is local, so whoever clones the project keeps the models. For a `--global` project
the definitions and the models live in your home folder: they are shared by every `--global` project on your machine,
and a clone on another machine has to run `wip init` again. To change a model later, edit the `model:` line in
`<defs>/agents/<name>.md`: the coordinator does it with a backup in `.wip/backups/defs/agents/` and checks the diff,
the flow lint and `wip check`, or you edit the line by hand.

What happens with `model:` in Claude Code:

- It reads it from `.claude/agents/`. It accepts an alias (`haiku`, `sonnet`, `opus`, `fable`), `inherit`
  or a full model ID. For a generic agent, `inherit` is the coordinator's model; for the coordinator, it is the model
  `claude` is started with. `claude --agent wip` reads the coordinator's `model:` when it starts, so a change to it
  needs a restart. If the running session does not pick up a generic's change, open `/agents` or restart it.

## Flows

A flow is one skill, `<defs>/skills/wip-flow-<name>/SKILL.md`: the folder's suffix is the flow's name, and its
frontmatter carries `name: wip-flow-<name>` and a `description` that says which items it is for. Its `wip-flow`
block is the only source of its phases:

```wip-flow
version: 1
fields:
  title: string
phases:
  - name: intake
    gate: none
    next: [review]
    waiting_default: user
  - name: review
    gate: ask
    next: [fix, done]
    agent: thinker
    writes: artifacts
  - name: fix
    gate: auto
    next: [review]
    agent: efficient
    writes: project
  - name: done
    kind: terminal
```

The text around the block (`## Subagents`, one `### <phase>` per phase) tells the coordinator what each phase does.
The reference of every key (`id_pattern`, `fields` and their types, `links`, `seed` and its `files`, `stage`, `gate`,
`waiting_default`, `agent`, `writes`, `from_any`, `polling`) is in `<defs>/skills/wip-new-flow/SKILL.md`, and `wip-new-flow/example.md` is a complete flow
to copy from (it is not a flow itself: only folders named `wip-flow-*` are).

The default flow, `tasks`, is generic: the same phases carry code, an investigation, a document or a decision,
grouped in three stages.

| Stage         | Phases                         | What happens                                                                                                                               |
| ------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `preparation` | `intake` → `research` → `plan` | the request; context, sources and options (skipped when clear); a plan that fixes what is delivered and how it is checked, approved by you |
| `execution`   | `execute` → `check`            | the deliverable; its check against the plan's criteria, back to `execute` when red                                                         |
| `review`      | `review` → `deliver` → `done`  | you validate the result; `deliver` only when something is written outside the project (a pull request, a message, a ticket)                |

A request that needs no work, or that you drop, goes from `intake` straight to `done`. `plan` is reachable from any
phase (`from_any: true`): a wrong approach goes back to it, and its gate, without `--force`.

To create a flow, ask the coordinator («create a flow for reviews with these phases…»): it follows `wip-new-flow`
(proposal, your approval, backup, write, `wip flow lint`, restore if the lint fails). By hand:

```sh
mkdir .claude/skills/wip-flow-review
cp .claude/skills/wip-new-flow/example.md .claude/skills/wip-flow-review/SKILL.md   # then edit it
wip flow lint review                               # exit 0, or one line per problem and exit 1
wip phase R1 intake --flow review
wip state --flow review
```

`wip flow lint` checks the frontmatter (`name` equal to the folder, a `description`), the block's schema, that
every phase is reachable through `next` or `from_any`, one or more terminal phases and that each other phase can reach one of them, `next` targets, `waiting_default`, `links` patterns, that each `agent:`
exists in `<defs>/agents/` with a `name` and a `description`, that `writes` is `artifacts` or `project`, that each `polling` entry names an existing phase and agent and has a valid
cadence, and that no live item sits in a phase the file removes.
Each valid version is stored when a command loads it: if a later edit breaks the file, `flow lint` fails, and every
other command keeps using the last valid version with a `flow_invalid` warning until the file is fixed.

`wip flow disable <flow>` switches a flow off in this copy of the project (a flag in `.wip/wip.sqlite`, no file
changes): its items leave `wip state`, `wip check`, the polls and the board, and every write on them exits 3.
`wip show <ID>` still shows them with a `flow_disabled` warning. `wip flow enable <flow>` brings it back; `wip flow lint` lists the disabled flows.

## The commands

| Command                                         | What                                                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| `wip init`                                      | create `.wip/` and the definitions                                            |
| `wip start`                                     | run the coordinator: the start command saved in `.wip/config.json`            |
| `wip phase <ID> <phase> [--flow F]`             | create an item, or move it along its flow's `next` or to a `from_any` phase   |
| `wip set <ID> key=value …`                      | set fields (`int +N`, `list +a/-a`, `ts now/none`)                            |
| `wip wait <ID> user\|external\|none\|agent:<a>` | record who the item waits on                                                  |
| `wip agent start\|stop <ID> …`                  | record a subagent run                                                         |
| `wip gate open\|close <ID> …`                   | open or close a decision for the user                                         |
| `wip log <ID> "<text>"`                         | add a note to the item's history                                              |
| `wip show <ID>`                                 | one item with its runs, gates, history and totals                             |
| `wip state [--attention]`                       | every item and what it waits on                                               |
| `wip archive <ID> [--no-prune]`                 | archive an item with nothing running nor open; prunes its folder to the trash |
| `wip prune <ID>\|--archived [--dry-run]`        | move an archived item's dependencies, builds and `tmp/` scratch to the trash  |
| `wip session start`                             | a coordinator (re)starts: runs left running become `orphaned`                 |
| `wip check [<ID>]`                              | the invariants (exit 1 on findings) and the warnings                          |
| `wip flow lint [<flow>]`                        | validate the flows; lists the disabled ones as `DISABLED <flow>`              |
| `wip flow disable\|enable <flow>`               | hide a flow and freeze its items, or bring it back                            |
| `wip poll due\|record\|seen`                    | the flows' scheduled checks: what is due, record a pass, what a pass saw      |
| `wip cron add\|list\|done\|cancel\|snooze`      | scheduled reminders and fixed-time poll passes, kept across sessions          |
| `wip web [status\|stop\|log]`                   | the kanban: serve it, check it, stop it, read its log                         |

Every command accepts `--json` (envelope `{ok, item, events, warnings, message, data}`) and `--help`. Exit codes:
0 ok · 1 findings · 2 usage · 3 rejected · 4 not found (or no `.wip/`) · 10 database. `WIP_HOME` points the CLI at
another project, only if that directory contains a `.wip/`.

## `wip prune`

An archived item keeps its documents, but its folder `.wip/items/<flow>/<ID>/` can hold dependencies, builds, binaries,
browser profiles and the scratch of `tmp/`. `wip prune` moves those to the system trash; `wip archive` runs it by
default (`--no-prune` skips it).

```sh
wip prune <ID> --dry-run            # list what would go; nothing is touched, the database is not even created
wip prune <ID>                      # do it
wip prune --archived [--flow F]     # every archived item (SKIP lines for the ones it refuses)
wip prune <ID> --keep tmp/probe.ts  # keep files of tmp/ (absolute paths with --archived)
wip prune <ID> --dry-run --report /abs/report.md
```

| Rule | Where                        | What goes                                                                                                                                          |
| ---- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | any level, not in `_backup/` | directory `storybook-static`                                                                                                                       |
| D2   | `tmp/`                       | regular file of 1 MB or more with a Mach-O or ELF header                                                                                           |
| D3   | any level below the root     | directory `node_modules`                                                                                                                           |
| D4   | any level below the root     | browser profile: `chrome-prof*`, or a folder with `Default/Login Data` or `Local State` (never rescued by `--keep`)                                |
| D5   | any level below the root     | `__pycache__`, `*.pyc`, `.DS_Store`                                                                                                                |
| D6   | `tmp/`                       | `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`, `*.db`                                                                                                 |
| D7   | `tmp/`                       | everything else, unless R1, R2 or `--keep`                                                                                                         |
| R1   | `tmp/`                       | media (png, jpg, gif, webp, mp4, webm, mov, pdf, svg) that a `.md` of the item outside `tmp/` cites by name or path stays                          |
| R2   | `tmp/`                       | text (md, txt, json, tsv, csv, diff, patch, sh, ts, py, yml; 1 MB at most) cited by path stays                                                     |
| K1   | whole folder                 | every entry at the root of the folder stays (documents, `prune.md`, links); `_backup/` only D3-D5; `gifs/`, `evidence/`, `design/`, `qa-*` only D4 |

Safety: only archived items; the item folder must be exactly `.wip/items/<flow>/<ID>` and not a symbolic link, nor
contain or sit inside an open item's folder (`<ID>` exits 3, `--archived` prints `SKIP`); symbolic links are never
followed or moved. Nothing is deleted: the entries are renamed into one staging folder `.wip/tmp/wip-prune-<ts>/<flow>/<ID>/`
and a single call sends it to the trash. If the trash fails the files stay in staging and the command exits 1 naming the
folder. `.wip/backups`, `.wip/logs` and the database are never pruned.

Trash per platform: macOS `/usr/bin/trash`; Linux `gio trash`, else `trash-put` (first found on `PATH`); Windows the
recycle bin through `powershell`. `WIP_TRASH_CMD` (one executable path, called with the staging folder as its only
argument) replaces them. With no trash command `wip prune` exits 3, and `wip archive` archives anyway with a warning
(`repeat with wip prune <ID>`): on a server or CI set `WIP_TRASH_CMD`.

Exit codes: 0 ok · 1 something failed to move · 2 usage · 3 rejected (open item, wrong folder, no trash command) · 4 item
not found. A real run writes `prune.md` in the item folder (date, destination, totals per rule, one line per entry,
rescues, browser profiles kept at the root, errors) and a `pruned` milestone in the item's history, only once the trash
took the folder. If the trash fails, the pruned files stay in `.wip/tmp/wip-prune-<ts>` (exit 1, no milestone) and the next
real `wip prune` (any form) sends every leftover staging folder to the trash first. A rerun with nothing new to move stamps
its date on `prune.md`. A browser profile at the item root stays (the root is never pruned) and is reported as
`kept at the root`.

## `wip web`

```sh
wip web            # http://localhost:33333/, or the next free port up to 33352
wip web --port N   # exactly on port N
wip web --local    # only on 127.0.0.1
wip web --open     # and open http://localhost:<port>/ in the browser
wip web status     # this project's servers: port, PID and URL
wip web stop       # stop this project's servers (--port N: only that one)
wip web log -n 20  # the last lines of its log; --follow keeps printing
```

A read-only kanban of the project, served from the binary with nothing external: one board per flow (columns by
`stage` or by phase; each stage in one blue, more transparent stage after stage, with readable text in the light and
dark themes, and no colour for a phase without a stage), «Your turn», open gates, running agents, the history with archived items, each item's runs,
gates and artifacts (Markdown rendered; every artifact is served with a `sandbox` CSP). Each flow can be collapsed
from its header, which keeps showing its open items and how many wait on you; the browser remembers the choice
(`localStorage`), and History keeps its `Flow` filter. Requests with a foreign
`Host` header are rejected. Without `--port`, running it again for the same project reports the running one and
exits 0 (with `--open`, it opens the browser on it); otherwise it serves on 33333 and, when something already
accepts connections there (on `127.0.0.1` or `[::1]`) or the port does not bind, tries 33334, 33335… up to 33352,
and exits 3 when all twenty are taken. `WIP_WEB_PORT` moves the first port of that range. `--port N` serves on
exactly N: this project's `wip web` there exits 0, another project's or another program exits 3. Ctrl-C or
`wip web stop` stops it. If no browser opens (`open`, `xdg-open` or `start` fails), `--open` prints a warning and the
server keeps serving.

While it serves, each server records its PID and port in `.wip/web/<port>.json`, and `.wip/logs/web.log` gets the
start with its addresses, every port skipped, every response with status ≥ 400, every error and the stop; past 1 MB
the log moves to `web.log.1`. `status` and `stop` read only that registry (and a `.wip/web.pid` from an older build):
each entry is checked on its own port through `/health`, which names the project and the PID, and an entry whose
process is gone or whose port answers for someone else is removed. No other port is asked. A project folder moved
while its server runs leaves that server unrecorded: stop it by hand.

Exit codes:

- `wip web status`: 0 at least one server of this project answers · 1 none. It lists one line per server, by port:
  port, PID, `Local:` and `LAN:` URLs (`not answering` for one that accepts connections but does not answer).
- `wip web stop`: 0 stopped (SIGTERM to each, then it waits up to 10 s) · 1 none was running · 3 one did not stop.
  Without `--port` it stops every server of this project; with `--port N`, only the one recorded on N. It never
  signals a process whose `/health` does not name this project and that PID.
- `wip web log`: 0 · 4 no log yet.

**LAN:** without `--local`, `wip web` also listens on your private LAN address and prints it as `LAN:`. Anyone on
that network can then read the board and the item artifacts, with no authentication. Use `--local` on networks you
do not trust.

## Polling

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

A pass at a fixed time (every Monday at 09:00, say) is a cron: `wip cron add --poll <flow>/<poll>` (see «Cron»).

## Cron

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

## Coordinating with Claude Code

wip never calls Claude Code: the coordinator calls wip. The coordinator is the `wip` agent, which Claude Code loads
with the skill `wip-coordinate` from `<defs>/`; `wip start` launches it with the start command saved in
`.wip/config.json` (by default `claude --agent wip --name wip-{stamp}`), and bare `wip` does the same in a terminal.

The **Runtime interface** section of `wip-coordinate` maps the protocol's capabilities to Claude Code's tools. On the
first message of every session, whatever it says (with Claude Code, the coordinator's own `initialPrompt`), the
coordinator starts with `wip session start`, `wip state --attention` and `wip check`, and never relaunches a run it
finds `orphaned`: it tells you. It also asks `fast`, in the background, to bring up the kanban: `wip web status` says
whether this project's `wip web` is up; if it is, no second one starts. Otherwise `fast` runs `wip web --open`, which
takes the first free port from 33333 and opens the browser. You get one line with the URL and the port, and a warning
only when the start fails. When a later `wip web status` finds the kanban down or its log with errors, the
coordinator tells you; it starts it again or stops it only when you ask.

## Development

Requires the Bun version in `.bun-version`, and Node 22.13 or later to run the npm package.

```sh
bun install
bun run typecheck              # tsc on everything, then src/ alone with Node types only
bun run lint                   # biome; src/ may not use Bun APIs (bun:*, Bun.*)
bun test                       # unit and e2e, the CLI in-process
bun src/main.ts --version      # the CLI from source (bun run dev): 0.1.0 (source)
```

**One source, two runtimes.** `src/` uses only `node:*` modules, which Bun implements too: SQLite through
`src/sqlite.ts` (`node:sqlite`), the web server on `node:http`, YAML through the `yaml` package bundled in. So the
same code runs on Node (the npm package), on Bun (tests and `bun src/main.ts`) and inside the compiled binary. Biome,
`tsconfig.src.json` and `test/unit/runtime-agnostic.test.ts` keep Bun-only APIs out of `src/`; tests and scripts stay
on Bun. `src/cli.ts` exports `main(argv)`; `src/main.ts` runs it (dev and binary) and the npm package's `bin/wip.mjs`
runs it on Node.

**Build.** `scripts/build.ts` always writes the npm package to `dist/npm/wip/`: `dist/wip.mjs` (src/ bundled for Node
with `bun build --target node`: migrations, templates, the web page, `yaml` and `@garndev/markdown` inlined),
`bin/wip.mjs` (from `npm/wip/bin/wip.mjs`: checks the Node version, hides Node 22's SQLite warning, sets
`WIP_LAUNCH_BIN`, runs `main`), `package.json` (from `npm/wip/package.json`), README and LICENSE; the build fails if
the folder holds anything else. `--pack` runs `npm pack` on it (`dist/garndev-wip-<version>.tgz`). `--targets`
also compiles standalone binaries with `bun build --compile` into `dist/bin/<os>-<arch>/` and archives them in
`dist/release/` (`wip-<version>-<os>-<arch>.tar.gz`, `.zip` for Windows) with `SHA256SUMS`; CI does not build them:

```sh
bun scripts/build.ts --out dist --pack                  # the npm package and its tarball
bun scripts/build.ts --targets host --out dist --pack   # plus this machine's binary (bun run build)
bun scripts/build.ts --targets all --out dist           # plus the five binaries
npm publish --dry-run dist/npm/wip                      # what npm would publish
```

`scripts/build.ts` fixes the branch, the short commit, whether the tree is dirty (untracked files count) and the build
date into the bundle and the binaries; `SOURCE_DATE_EPOCH` sets the date. Without git they read `no git`.
`wip version --json` returns them as `branch`, `commit`, `dirty`, `built_at` and `source` (true when run from source),
next to `version`.

**Try the build locally.** `bun run install:local --node` builds the npm package and installs its tarball with npm
into `dist/local`, as users get it, under the command name `wip2` so it does not shadow your `wip`; run
`dist/local/bin/wip2`. Without `--node` it installs this machine's binary as `dist/local/bin/wip2` instead.
`--prefix <dir>` installs elsewhere (for example `--prefix ~/.local/wip-dev`), `--out <dir>` builds elsewhere.
Neither needs the registry nor touches your global npm.

```sh
bun run install:local --node          # then dist/local/bin/wip2 --version
mkdir /tmp/wip-try && cd /tmp/wip-try && <repo>/dist/local/bin/wip2 init
```

Any command of a newer build migrates the database of the project it opens, and an older `wip` then refuses it
(exit 10), so try it in a project made with `wip init` in an empty folder, not in one your installed `wip`
still uses. `wip --version` prints the branch, the commit, a `-dirty` mark and the build date, so two builds of
the same version can be told apart.

**Install it globally.** `bun run install:global --name <name>` (for example `--name wip2`) builds the npm package
and installs it into the global npm prefix (`npm prefix -g`), replacing the installed `@garndev/wip` in place so a
path pinned in a project's `wip_bin` stays valid. It refuses a dirty working tree (`--allow-dirty` overrides) and a
prefix whose package provides another command (`--replace`, or `--prefix <dir>` to install elsewhere). It never opens
a project database: it prints the steps to run by hand (stop `wip web`, back up, check `user_version`, `<name> check`,
restart), because the first command of a newer build migrates the project.

**End-to-end against the package or the binary.** The e2e tests run the CLI in-process unless `WIP_TEST_BIN` names
a binary or the package's `bin/wip.mjs` (run with `node`). `test/e2e/pack.test.ts` only runs with `WIP_PACK_DIR`:
it builds the package tarball and the host binary there (if they are not there yet), installs the tarball with npm
into a prefix inside that folder (`--offline`) and runs the installed `wip` on Node, and the binary with neither Node
nor Bun in `PATH`.

```sh
WIP_PACK_DIR=/tmp/wip-pack bun test test/e2e/pack.test.ts
WIP_TEST_BIN=/tmp/wip-pack/npm/wip/bin/wip.mjs bun test test/e2e      # on Node
WIP_TEST_BIN=/tmp/wip-pack/bin/darwin-arm64/wip bun test test/e2e     # on the binary
```

**CI.** `.github/workflows/ci.yml` runs on pushes to `main` and `v1` and on pull requests: typecheck, lint and tests
on Linux, macOS and Windows; the npm package packed once and checked with `npm publish --dry-run`; and the e2e suite
against it on Node 22, 24 and 26 (Linux) and Node 24 (macOS, Windows). `.github/workflows/release.yml` publishes a
tagged version of the npm package and makes its GitHub Release with the CHANGELOG notes; see `docs/releasing.md`.
Neither workflow builds the binaries.

The root `package.json` (`@garndev/wip-dev`) is private and never published; only `dist/npm/wip` is.
