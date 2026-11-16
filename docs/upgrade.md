# `wip upgrade`

[← Back to the README](../README.md)

`wip upgrade` brings the npm install of `@garndev/wip` you are running to the newest version of a channel and, using
that new version, refreshes the Kanban mod of the current project. It also compares the project's definitions folder
with the templates embedded in the running build and says whether [`wip init --force`](init.md) would change anything;
it writes them only when you ask with `--apply-defs`. It never touches a project database and never installs or
enables the mod where it was absent unless you pass `--kanban`.

```sh
wip upgrade                 # the CLI, an existing wip-owned Kanban copy, and the definitions comparison
wip upgrade --check         # is there a newer version or outdated definitions? exit 1 when there is; writes nothing
wip upgrade --dry-run       # the npm command, the mod step and the definition files, writing nothing
wip upgrade --channel next  # prereleases instead of latest
wip upgrade --kanban        # also install the mod and its enabledPlugins entry where missing or disabled
wip upgrade --no-kanban     # the CLI and the definitions, not the mod
wip upgrade --apply-defs    # the definitions part of `wip init --force`, in place and with backups
wip upgrade --no-defs       # the CLI only (and the mod, unless --no-kanban)
```

## What it updates

**The CLI, from npm only.** The target is the exact version of the channel's dist-tag (`latest` by default, `next`
with `--channel next`), installed with:

```sh
npm install -g --prefix <prefix> --no-audit --no-fund --no-update-notifier --ignore-scripts @garndev/wip@<version>
```

`<prefix>` is derived from the package you are running (`npm prefix -g` is never asked): a custom `--prefix`, nvm,
Volta and a package install under another Node version are left alone. Your npm registry configuration applies, a
private mirror included. The version is exact so the output names what was installed. Nothing is fetched from
GitHub.

The installed CLI is then **verified by running it** (`<node> <package>/bin/wip.mjs version --json`). If it does not
start, exits non-zero or reports another version, `wip upgrade` reinstalls the previous exact version and exits 1.
The rollback restores the CLI only: a database the new version already migrated is not rolled back (see
[installation](install.md) for the manual backup and restore).

A target older than the running version is reported, never installed, so moving from `next` back to `latest` does
not downgrade.

**The Kanban mod of the current project, with the new embedded copy.** The mod is not a package: the files to install
travel inside whichever `wip` process has them, so the CLI is upgraded first and the mod is refreshed by the
installed CLI. By default only an existing copy marked as wip's is replaced; edited files and extra files inside it
are replaced (`.claude-plugin/types/` is kept) after copying the folder to
`.wip/backups/kanban/wip-kanban.<stamp>/`, and neither settings file is read for writing, so a disabled plugin stays
disabled. A missing or foreign folder is skipped with the reason. `--kanban` installs the copy and merges
`"enabledPlugins": {"wip-kanban@skills-dir": true}` into the settings file that already wins the entry (else
`.claude/settings.json`), with the same preflight, backups and warnings as [`wip init`](init.md); a foreign folder or
settings that cannot take the entry exit 3 with nothing written. There is no merge of your edits.

After a mod change, run `/reload-plugins` or start a new Claude Code session.

## What's new

After a successful upgrade, `wip upgrade` prints the CHANGELOG sections between the version it replaced and the one
it installed, newest first:

```text
upgraded wip 0.5.1 -> 0.6.0 (latest)

what's new (0.5.1 -> 0.6.0):
0.6.0 (2026-11-20)
- ...
0.5.2 (2026-11-16)
- ...
```

The notes come from the `CHANGELOG.md` that the target package itself ships, read from the package `npm` just
installed. The file is cumulative, so a jump across several versions shows every section in `(old, new]` and never
repeats the running version's own. Nothing else is fetched. The text block stops at 40 lines: a long range ends with
how many lines are not shown, and `--json` keeps every entry in `data.changelog` (`from`, `to`, `entries`,
`truncated`).

The notes never change the outcome and the exit code stays the same: a target package without the file warns
`changelog_missing`, and one with no section in the range warns `changelog_empty`. `--check`, `--dry-run`, an
already-current run and `--apply-mod` show none, because no install happens and the target package is not on disk;
a source run and a standalone binary are never upgraded by wip, so read the [CHANGELOG](../CHANGELOG.md) for those.

## The definitions

`wip upgrade` compares `<defs>/agents` and `<defs>/skills` with the templates embedded in the running build and says
what [`wip init --force`](init.md) would write. The comparison is not a byte diff: it is the text `--force` would
write, so the `model:` line of the coordinator and of a generic agent is kept and a model-only edit is **not** drift.

```text
defs: up to date (.claude/)
defs: 2 out of date in .claude/ (1 changed, 1 missing); run `wip upgrade --apply-defs`
changed .claude/agents/wip.md
missing .claude/skills/wip-flow-tasks/guide.md
kept 1 custom definition (not touched)
```

Each template path is one of four classes: `changed` (a `wip:`-marked file differs), `missing`, `foreign` (no `wip:`
mark, or a directory or a symlink at that path: another tool's, it blocks the refresh) or current (not listed). A
custom agent or skill that no template writes is `kept`: it is listed and never deleted. The warnings are
`defs_outdated` (changed plus missing) and `defs_foreign`; `--json` carries the same facts in `data.defs`, with the
version of the build that compared.

A shipped flow is compared only when its `skills/wip-flow-<name>/` folder exists; a folder with **no** `wip-flow-*`
folder at all scopes every shipped flow, so a wiped folder can be repaired. A project initialised with
`--flows tasks` is therefore never offered the development, ideas or reports flows. The target is the configured
`defs_dir`: the local folder (`.claude/`, or any relative folder) or a `~/…` folder from `wip init --global`, which is
shown in full and marked as shared, with the backups still in the running project's `.wip/backups/defs/`.
`wip upgrade` never opens the database, so it cannot read `flows.disabled`: a disabled flow's files are compared and
refreshed like any other flow's and the flow stays disabled.

`--apply-defs` applies the definitions part of `wip init --force` in place: the same writer, the same `model:`
preservation, the same `.wip/backups/defs/` backup per replaced file, the same refusal of another tool's file (exit 3,
nothing written). It seeds no items, adds no flow you did not select, never switches `defs_dir`, never migrates a
legacy folder and never edits `.gitignore`. It is public (unlike the internal `--apply-mod`), it is its own mode (it
takes no `--check`, `--dry-run`, `--channel`, `--kanban` nor `--no-defs`), it needs a project (exit 4 outside one) and
it works from a source run and from a binary, without npm or the registry.

```text
defs: .claude/ (wip 0.6.2)
replaced .claude/agents/wip.md (backup .wip/backups/defs/agents/wip.md.20261116T101500Z)
created .claude/skills/wip-flow-tasks/guide.md
defs: 2 files written (1 created, 1 replaced); 1 custom definition kept
```

A second run says `defs: up to date (.claude/); nothing written`. `--dry-run` prints the same plan as `defs: would
write …` and writes nothing. `--no-defs` turns the comparison off and `data.defs` is null.

A normal run only proposes: it prints the comparison and warns, and never writes. When an npm update is available, the
templates embedded in the old build are not the target version's, so the run does not print the old build's drift;
after a successful install it prints ``defs: run `wip upgrade --apply-defs` to compare the definitions with wip
<target>`` and leaves the comparison to the freshly installed CLI.

## What it does not touch

- A project database: `wip upgrade` never opens, creates or migrates `.wip/wip.sqlite`. The next command of the
  upgraded version that opens a project may migrate it, as any upgrade does; the output notes it. A disabled flow's
  flag stays as it is for the same reason.
- `.wip/config.json`: not `wip_bin`, not `start`, not `defs_dir`, not `flow_order`. If the project's `wip_bin` points
  somewhere else, the command warns (`wip_bin_pinned`) and leaves the value as it is. Run `wip upgrade` there, or
  re-point `wip_bin` by hand.
- The definitions folder (`<defs>/agents`, `<defs>/skills`): read by the comparison, and written only by
  `--apply-defs`; `wip init --force` remains the broader refresh.
- Other projects: there is no project registry. Run `wip upgrade` in each project, or `wip init --force` to refresh
  its definitions and copy together.
- A standalone binary, or a source run (`bun run dev`): the CLI update is npm only. `--check` and `--dry-run` still
  resolve the registry and name the manual command; `--apply-defs` needs neither and works.

## Which installs can be upgraded

`wip upgrade` replaces only an npm global install of the unrenamed package. It exits 3, before running anything, for:

- a source run: `npm install -g @garndev/wip@latest`, or run it from a package or a binary;
- a standalone binary: build the new version from source (see [installation](install.md)); wip never overwrites a
  running binary;
- a Bun global install: `bun add -g @garndev/wip@latest`; npm would create a parallel layout Bun does not use;
- an `npm link` or a copy outside npm's layout: install it with npm;
- a package renamed with `--bin-name` (for example `wip2`): installing the registry package would remove the command.
  Reinstall the tarball with the same `--bin-name`, or install `@garndev/wip` under `wip` and re-point `wip_bin` by
  hand (wip never writes it).

## Output and exit codes

Text mode names the running install, the resolved target, the npm command when it runs, the old and new version,
the release notes ([What's new](#whats-new)), what happened to the mod and its backup, the definitions comparison
([The definitions](#the-definitions)), and the reload note. `--json` carries the same facts in `data` (see
[Commands](commands.md) for the envelope), with the notes in `data.changelog` and the comparison in `data.defs`.

| Code | When                                                                                                                                                 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | upgraded, already up to date, `--dry-run` printed, `--apply-defs` applied or current, or the internal mod step done                                  |
| 1    | `--check` found an update or outdated definitions; the install, the verification or the rollback failed; the CLI was upgraded but the mod was not    |
| 2    | usage: a positional argument, `--check --dry-run`, `--kanban --no-kanban`, an unknown `--channel`, `--apply-defs` with its exclusive flags           |
| 3    | refused before any write: this install, the registry or tag, a network or npm failure, `--kanban`'s preflight, or a foreign file with `--apply-defs` |
| 4    | `--kanban`, `--apply-defs` or the internal mod step in a directory without `.wip/`                                                                   |

A failed npm install leaves the CLI as npm left it: the command never retries as root and never widens permissions.

## Roll back

The CLI only, when the new version does not work:

```sh
npm install -g @garndev/wip@<previous version>
```

Then, in each project the newer version already opened, stop every `wip` process and restore the copy taken before
the migration: `cp .wip/backups/db/wip.sqlite.v<schema>.<time>.<pid> .wip/wip.sqlite` (or your own backup; see
[Back up a project's state by hand](install.md#back-up-a-projects-state-by-hand)) and delete `wip.sqlite-wal` and
`wip.sqlite-shm`. Changes made after the upgrade are lost on restore; there is no down-migration. A project's
Kanban copy is independent of the database and stays as the newer CLI left it; `wip upgrade` after the rollback
refreshes it with the older embedded copy.

## `--apply-defs`, `--apply-mod` and `--check`

`--check` resolves the channel, writes nothing and exits 1 when a newer version exists **or** the definitions differ
(changed, missing or foreign; `--no-defs` restores the old meaning, for scripts). It is the script path, so it needs
the registry: the offline path is `--apply-defs`. `--dry-run` prints the exact npm command, the mod step and the
definition files and exits 0.

`--apply-defs` is the public definitions mode described in [The definitions](#the-definitions): no registry, no npm,
no install refusal, a backup per replaced file, exit 3 on another tool's file.

`--apply-mod` is internal: after an install, `wip upgrade` runs the new CLI's own copy of it so the mod comes from
the new code. It takes no `--check`, `--dry-run` or `--channel`, and users never type it.

The command is safe to repeat: a second run sees the running version, runs no npm install, and reports the mod as
`exists` when nothing changed.
