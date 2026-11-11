# `wip upgrade`

[← Back to the README](../README.md)

`wip upgrade` brings the npm install of `@garndev/wip` you are running to the newest version of a channel and, using
that new version, refreshes the Kanban mod of the current project. It is one command, not a replacement for
`wip init --force`: it touches neither the definitions folder nor a project database, and it never installs or
enables the mod where it was absent unless you pass `--kanban`.

```sh
wip upgrade                 # the CLI, then an existing wip-owned Kanban copy
wip upgrade --check         # is there a newer version? exit 1 when there is; writes nothing
wip upgrade --dry-run       # the npm command and the mod step, writing nothing
wip upgrade --channel next  # prereleases instead of latest
wip upgrade --kanban        # also install the mod and its enabledPlugins entry where missing or disabled
wip upgrade --no-kanban     # the CLI only
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

## What it does not touch

- A project database: `wip upgrade` never opens, creates or migrates `.wip/wip.sqlite`. The next command of the
  upgraded version that opens a project may migrate it, as any upgrade does; the output notes it.
- `.wip/config.json`: not `wip_bin`, not `start`, not `defs_dir`, not `flow_order`. If the project's `wip_bin` points
  somewhere else, the command warns (`wip_bin_pinned`) and leaves the value as it is. Run `wip upgrade` there, or
  re-point `wip_bin` by hand.
- The definitions folder (`<defs>/agents`, `<defs>/skills`): that stays `wip init --force`.
- Other projects: there is no project registry. Run `wip upgrade` in each project, or `wip init --force` to refresh
  its definitions and copy together.
- A standalone binary, or a source run (`bun run dev`): the CLI update is npm only. `--check` and `--dry-run` still
  resolve the registry and name the manual command.

## Which installs can be upgraded

`wip upgrade` replaces only an npm global install of the unrenamed package. It exits 3, before running anything, for:

- a source run: `npm install -g @garndev/wip@latest`, or run it from a package or a binary;
- a standalone binary: download the new archive from the GitHub Release (see [installation](install.md)); wip never
  overwrites a running binary;
- a Bun global install: `bun add -g @garndev/wip@latest`; npm would create a parallel layout Bun does not use;
- an `npm link` or a copy outside npm's layout: install it with npm;
- a package renamed with `--bin-name` (for example `wip2`): installing the registry package would remove the command.
  Reinstall the tarball with the same `--bin-name`, or install `@garndev/wip` under `wip` and re-point `wip_bin` by
  hand (wip never writes it).

## Output and exit codes

Text mode names the running install, the resolved target, the npm command when it runs, the old and new version,
what happened to the mod and its backup, and the reload note. `--json` carries the same facts in `data` (see
[Commands](commands.md) for the envelope).

| Code | When                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------- |
| 0    | upgraded, already up to date, `--dry-run` printed, or `--apply-mod` done                                                  |
| 1    | `--check` found an update; the install, the verification or the rollback failed; the CLI was upgraded but the mod was not |
| 2    | usage: a positional argument, `--check --dry-run`, `--kanban --no-kanban`, an unknown `--channel`                         |
| 3    | refused before any write: this install, the registry or tag, a network or npm failure, or `--kanban`'s preflight          |
| 4    | `--kanban` or the internal `--apply-mod` in a directory without `.wip/`                                                   |

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

## `--apply-mod` and `--check`

`--check` resolves the channel, writes nothing and exits 1 when a newer version exists; it is the script path.
`--dry-run` prints the exact npm command and the mod step and exits 0.

`--apply-mod` is internal: after an install, `wip upgrade` runs the new CLI's own copy of it so the mod comes from
the new code. It takes no `--check`, `--dry-run` or `--channel`, and users never type it.

The command is safe to repeat: a second run sees the running version, runs no npm install, and reports the mod as
`exists` when nothing changed.
