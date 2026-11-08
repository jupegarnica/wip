# `wip prune`

[← Back to the README](../README.md)

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

`wip archive` and the rest of the command table are in [Commands](commands.md).
