# Install

[← Back to the README](../README.md)

`@garndev/wip` is not published to the npm registry yet: the first release is pending (see [Releasing](releasing.md)).
Until then, build the package from this repository (see [CLAUDE.md](../CLAUDE.md)) and install its tarball the same
way.

**Requirements:** Claude Code's `claude` CLI, Node 22.13 or later and npm, on any OS Node supports. Without Node: a
standalone binary you build from this repository (Bun needed for the build only) for `darwin-arm64`, `darwin-x64`,
`linux-x64` (a CPU with AVX2), `linux-arm64` or `windows-x64` (experimental).

## Before installing: is `wip` already taken?

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

## With npm

```sh
npm install -g @garndev/wip
wip --version              # <version> (<branch> <commit>, built <date>)
cd my-project && wip init  # writes .wip/ and the definitions; see init.md
```

The package holds a JavaScript bundle and the `wip` command, nothing else: no dependencies, no install scripts, no
platform packages. On Node 22 the bundled `node:sqlite` is still flagged experimental; `wip` hides that one warning.

`wip init` is described in [Start a project: `wip init`](init.md).

## Without Node: a binary built from source

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
The contributor flow around the build (targets, build metadata, local installs) is in [CLAUDE.md](../CLAUDE.md).

## Upgrade

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

## Back up a project's state by hand

With no `wip` process running in the project (no `wip web`, no coordinator session):

```sh
sqlite3 .wip/wip.sqlite ".backup '.wip/backups/wip.sqlite.$(date +%Y%m%d%H%M%S)'"
# without sqlite3: copy wip.sqlite together with wip.sqlite-wal and wip.sqlite-shm if they exist
```

The item folders (`.wip/items/`) are plain files and are not migrated; the definitions folder is versioned in git
(or lives in `~/.claude` with `--global`).

## Roll back

```sh
npm install -g @garndev/wip@<previous version>
```

Then, in each project the newer version already opened, stop every `wip` process and restore the copy taken before
the migration: `cp .wip/backups/db/wip.sqlite.v<schema>.<time>.<pid> .wip/wip.sqlite` (or your own backup) and delete
`wip.sqlite-wal` and `wip.sqlite-shm`. Changes made after the upgrade are lost on restore; there is no
down-migration.

## Uninstall

```sh
npm uninstall -g @garndev/wip     # a binary: delete the file
```

Project state is not touched: delete `.wip/` per project if you want it gone, and the definitions (`.claude/agents|skills`
files with a `wip:` mark, or `~/.claude/` for `--global`) by hand.

The command table, `--json` and the exit codes are in [Commands](commands.md).
