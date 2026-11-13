# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`wip` (`@garndev/wip`) is a Bun/TypeScript CLI that keeps, per project, the state of the work an AI coordinator runs: items, the phase of each in a flow, running subagents, gates waiting on the user. State is SQLite in `.wip/` (git-ignored); there is also a read-only kanban (`wip web`). It ships as one npm package that runs on Node ≥ 22.13 (`dist/npm/wip`, a JavaScript bundle and a bin, no dependencies) and, optionally, as standalone binaries built locally with `--targets`; both come from the same `src/`. [README.md](README.md) is the product pitch and getting started. `docs/` is the user-facing reference (commands, flows, polling, exit codes). This file (`CLAUDE.md`) is the development guide.

## Documentation map

| File                        | What it is for                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `README.md`                 | pitch and getting started                                                              |
| `docs/install.md`           | installation, binary, upgrade, backup, rollback, uninstall                             |
| `docs/upgrade.md`           | `wip upgrade`: npm CLI, channels, Kanban mod, verification, rollback, exit codes       |
| `docs/init.md`              | `wip init`, scopes, `.gitignore`, the Kanban mod                                       |
| `docs/start.md`             | `wip start`, saved commands, `wip_bin`, `WIP_BIN`                                      |
| `docs/agents-and-models.md` | the four generics, levels, `model:`                                                    |
| `docs/flows.md`             | flow format, the `wip-flow` block, `flow lint`, disable/enable                         |
| `docs/commands.md`          | the command table, `--json`, exit codes, `WIP_HOME`                                    |
| `docs/prune.md`             | `wip prune`, rules, trash, safety                                                      |
| `docs/web.md`               | `wip web`, ports, LAN, logs                                                            |
| `docs/polling.md`           | scheduled checks, states                                                               |
| `docs/cron.md`              | reminders and fixed-time passes                                                        |
| `docs/coordinating.md`      | session start, attention, kanban                                                       |
| `docs/releasing.md`         | the maintainer's release process                                                       |
| `mods/wip-kanban/README.md` | the Kanban mod's own reference                                                         |
| `CLAUDE.md`                 | this file: development guide (commands, architecture, tests, builds, CI, release rule) |

## Documentation rules

- `README.md` is the pitch and getting started only: no command reference, no internals.
- User reference: one topic per `docs/*.md`; cross-link, never copy a paragraph.
- Development notes live in this file, `CLAUDE.md`.
- Links are relative between docs and from a doc to the README or this file; the README uses absolute GitHub URLs
  because npm ships only `README.md`.
- Never rename `README.md`, and never add a file to the npm package without changing `scripts/build.ts`,
  `npm/wip/package.json` and both tests (`test/unit/build-script.test.ts`, `test/e2e/pack.test.ts`).

## Commands

Requires the Bun version in `.bun-version`, and Node 22.13 or later to run the npm package.
The test root is `test/` (`bunfig.toml`).

```sh
bun install
bun test                              # unit + e2e, CLI runs in-process
bun test test/unit/gate.test.ts       # one file
bun test -t "name pattern"            # one test by name
bun run typecheck                     # tsc on everything, then src/ alone with Node types (tsconfig.src.json)
bun run lint                          # biome check . (2-space, 100 cols, double quotes); add --write to fix
bun src/main.ts <args>                # run the CLI from source (bun run dev)
bun scripts/build.ts --out dist --pack                  # the npm package dist/npm/wip + npm pack
bun scripts/build.ts --targets host --out dist --pack   # plus this machine's binary (bun run build)
bun scripts/build.ts --targets all --out dist           # plus the five binaries
npm publish --dry-run dist/npm/wip                      # what npm would publish
bun run install:local --node          # npm-install the package as wip2 into dist/local (without --node: the binary)
```

`scripts/build.ts` fixes the branch, the short commit, whether the tree is dirty (untracked files count) and the build
date into the bundle and the binaries; `SOURCE_DATE_EPOCH` sets the date. Without git they read `no git`.
`wip version --json` returns them as `branch`, `commit`, `dirty`, `built_at` and `source` (true when run from source),
next to `version`.

## Local builds and installs

`bun run install:local --node` builds the npm package and installs its tarball with npm into `dist/local`, as users
get it, under the command name `wip2` so it does not shadow your `wip`; run `dist/local/bin/wip2`. Without `--node` it
installs this machine's binary as `dist/local/bin/wip2` instead. `--prefix <dir>` installs elsewhere (for example
`--prefix ~/.local/wip-dev`), `--out <dir>` builds elsewhere. Neither needs the registry nor touches your global npm.

```sh
bun run install:local --node          # then dist/local/bin/wip2 --version
mkdir /tmp/wip-try && cd /tmp/wip-try && <repo>/dist/local/bin/wip2 init
```

`bun run install:global --name <name>` (for example `--name wip2`) builds the npm package and installs it into the
global npm prefix (`npm prefix -g`), replacing the installed `@garndev/wip` in place so a path pinned in a project's
`wip_bin` stays valid. It refuses a dirty working tree (`--allow-dirty` overrides) and a prefix whose package provides
another command (`--replace`, or `--prefix <dir>` to install elsewhere). It never opens a project database: it prints
the steps to run by hand (stop `wip web`, back up, check `user_version`, `<name> check`, restart), because the first
command of a newer build migrates the project.

The root `package.json` (`@garndev/wip-dev`) is private and never published; only `dist/npm/wip` is.

## Architecture

**Runtime.** `src/` must run on Node and on Bun: it uses only `node:*` modules (Biome forbids `bun:*` and `Bun.*` there; `test/unit/runtime-agnostic.test.ts` also forbids `import.meta.main`/`dir`). SQLite goes through `src/sqlite.ts` (a thin wrapper over `node:sqlite` with the bun:sqlite shape: `query().get/all/run`, `get()` → `null`, booleans as 0/1, `transaction().immediate()`), YAML through `src/yaml.ts` (the bundled `yaml` package), the web server is `node:http`. Tests and `scripts/` stay on Bun.

**Command dispatch.** `src/cli.ts` maps command names to `IHandler`s (`src/commands/*.ts`) and `run()` is the single entry point, used by every entry and by tests in-process; `main(argv)` adds the interactive parts and writes the output. `src/main.ts` calls it under Bun and in the binary; the npm package's `bin/wip.mjs` (from `npm/wip/bin/wip.mjs`) calls it on Node. A handler fills an `IResult` (`src/context.ts`) rather than printing; `cli.ts` renders either text `lines` or the JSON envelope (`--json`). Each handler declares `db: "none" | read | write`, which decides how the DB is opened. Errors are `WipError` with an exit code from `src/errors.ts` (0 ok, 1 findings, 2 usage, 3 rejected, 4 not found, 10 DB). Help text lives in `src/commands/help.ts` (`COMMANDS` specs); a new command needs its handler registered, its spec, and its tests.

**State and invariants.** `src/db.ts` opens SQLite (WAL, needs ≥ 3.37), copies a database it is about to migrate to `.wip/backups/db/`, and applies `src/migrations/*.sql`, embedded through `src/embedded/migrations.ts` (add a migration = new `.sql` file _and_ an entry there; `user_version` is the index + 1). `src/items.ts` holds item queries; `src/invariants.ts` checks I1/I2f/I2/I3/I4 of every item against its flow, and `wip check` reports them. `src/clock.ts` is injectable for tests.

**Flows are markdown, not code.** A flow is a skill `wip-flow-<name>` whose SKILL.md carries a block that `src/flow/parse.ts` parses into phases (`kind`, `gate`, `next`, `agent`, `writes`, `from_any`, fields, links, seed items); `src/flow/lint.ts` validates it (reachability, one or more terminal phases, every phase reaching one, etc.) and `src/flow/registry.ts` loads versions from the definitions folder. Agents (`src/agents.ts`) are `.md` files with frontmatter; files that `wip init` writes carry a `wip:` mark in frontmatter, which `--force` and conflict checks rely on.

**Definitions folder.** `.wip/config.json` stores `defs_dir` (`.claude`, or `~/…` for `init --global`, resolved against `HOME`/`USERPROFILE`). Everything reads definitions from there. `src/init/*` scaffolds it, never overwrites files, and never moves or deletes definitions; `init --force` migrates a legacy folder of the same scope to `.claude` and leaves the old one as it is.

**Interactive init.** `wip init` is a synchronous handler fed by flags (`--yes`, `--flows`, `--start`, `--start-default`, `--no-start`); the questions live outside `run()`, like `wip start`'s launch: `src/cli.ts` calls `promptInit` (`src/commands/init.ts`, questions in `src/init/ask.ts`, helpers in `src/init/prompt.ts`) only on a terminal without `--yes`/`--json`, which turns the answers into those flags before `run()`. The wizard has five steps (scope, flows, start, Git, Kanban); `--flows <names>` selects a subset of the four shipped flows and the wizard skips that step. The `model:` lines come from the templates under `templates/agents/`; init writes them as they are and never asks for or writes a model.

**Pinned binary.** `.wip/config.json` may hold `wip_bin` (absolute, `~/…` or project-relative path); the coordinator runs that executable instead of the global `wip`, so projects can use different versions. `init` preserves it.

**Upgrading.** `src/install.ts` knows what this process is: the build defines `WIP_INSTALL` (`"npm"` for the bundle, `"binary"` for a compiled binary; absent in a source run), `INSTALL_KIND` reports it in `version --json`, and `detectInstall` derives the package root and npm prefix from `import.meta.url` (the bundle at `<prefix>/lib/node_modules/@garndev/wip/dist/wip.mjs`) and refuses a source run, a binary, a Bun global store, an npm link or a renamed `bin`. `src/upgrade/version.ts` is a dependency-free SemVer comparison, `src/upgrade/npm.ts` builds and runs npm (`TRun` is the seam tests replace), and `src/upgrade/mod.ts` applies the embedded Kanban copy through `kanbanPreflight`/`syncKanban`/`applySettings`. `src/commands/upgrade.ts` (`db: "none"`) installs the exact channel version, verifies it by running it, rolls back a mismatch and then refreshes the mod; its hidden `--apply-mod` is how the freshly installed CLI applies its own files. It never opens a database nor edits `wip_bin`; a differing pin only warns.

**Embedded assets.** `templates/` (what `wip init` writes), `web/` (the kanban UI and `web/vendor/markdown.js`, the
minified `marked` bundle built by `bun run vendor:markdown`) are inlined into the binary via text imports
(`src/embedded/templates.ts`, `src/embedded/web.ts`). Adding a file under `templates/` or `web/` requires adding it to
the matching manifest; a test fails if one is missing. The Markdown preview renders semantic HTML from the vendored
`marked`; raw HTML is allowed and the page CSP is its limit (no sanitizer, so its bundle stays inside the budget).
`src/web/*` is the `node:http` server for `wip web`.

**Build.** `scripts/build.ts` always writes the npm package `dist/npm/wip/` (`bun build --target node` of `src/cli.ts` into `dist/wip.mjs`, `bin/wip.mjs`, `package.json` from `npm/wip/`, README, LICENSE; it fails if anything else ends up there) and embeds branch/commit/dirty/date (`src/build-info.ts`) and `WIP_INSTALL` (`npm` for the bundle, `binary` for a compiled binary) with `--define`. `--targets` also compiles binaries (`bun build --compile` of `src/main.ts`) into `dist/bin/<os>-<arch>/`, ad hoc signs darwin ones and archives them with `SHA256SUMS` into `dist/release/`. `--targets all` locally still includes `windows-x64`; `release.yml` builds no binaries. `bin/wip.mjs` checks Node ≥ 22.13 (exit 2), hides Node 22's SQLite ExperimentalWarning, sets `WIP_LAUNCH_BIN` (not on Windows) and imports the bundle.

## Two copies of the definitions

`templates/` is the **source** of what `wip init` ships (the flows `development`, `ideas`, `reports` and `tasks`, the four generic agents, coordinator skills). `.claude/agents` and `.claude/skills` in this repo are this project's own dogfooded definitions (used with `claude --agent wip`). The shipped flows and `wip-coordinate` are the exception to the rule that the two copies never sync: they must be byte-identical in both, and the sync test in `test/unit/templates.test.ts` fails when they drift. Any other template change does not update `.claude/`, and a project-only flow or agent belongs outside `templates/`; `templates/` is excluded from biome and `test/fixtures/` holds deliberately broken flows and agents used by lint/parse tests.

## Testing notes

Tests call `run()` in-process through helpers in `test/helpers/` (`project.ts` creates scratch projects under the OS temp dir, never a real project or `~/.claude`). JSON output is validated against `test/schemas/*.json`. `test/e2e/` covers init, flows, web servers and packing; `WIP_TEST_BIN` runs it against the npm package or a binary. `build-script`, `install-local` and `launcher` unit tests cover the scripts and `bin/wip.mjs`. `upgrade` tests inject a fake `TRun` and install info (the exported `setUpgrade*ForTests` seams in `src/commands/upgrade.ts`) and never reach the registry; the e2e ones only exercise `--apply-mod`.

**CI.** `.github/workflows/ci.yml` runs on pull requests, by hand (`workflow_dispatch`) and when `release.yml` calls it (`workflow_call`); the `push` trigger is commented out. It runs on Ubuntu only: typecheck, lint and `bun test`; it packs the npm package once, checks it with `npm publish --dry-run` and runs the e2e suite against it on Node 22. The `workflow_call` input `full: true` adds macOS and Windows and the other Node lines (24 and 26) for `.github/workflows/test.yml`, the manual (`workflow_dispatch` only) run of the full matrix. `.github/workflows/release.yml` (tag `v<version>`, or `workflow_dispatch` as a dry run) publishes the tested tarball to npm behind the `npm-publish` environment and makes the GitHub Release with the CHANGELOG notes and no assets. No workflow builds binaries: `--targets` builds them locally.

## End-to-end against the package or the binary

The e2e tests run the CLI in-process unless `WIP_TEST_BIN` names a binary or the package's `bin/wip.mjs` (run with `node`). `test/e2e/pack.test.ts` only runs with `WIP_PACK_DIR`: it builds the package tarball and the host binary there (if they are not there yet), installs the tarball with npm into a prefix inside that folder (`--offline`) and runs the installed `wip` on Node, and the binary with neither Node nor Bun in `PATH`.

```sh
WIP_PACK_DIR=/tmp/wip-pack bun test test/e2e/pack.test.ts
WIP_TEST_BIN=/tmp/wip-pack/npm/wip/bin/wip.mjs bun test test/e2e      # on Node
WIP_TEST_BIN=/tmp/wip-pack/bin/darwin-arm64/wip bun test test/e2e     # on the binary
```

**Release rule.** Never push a tag, publish to npm or create a GitHub Release without the user's explicit approval; follow [docs/releasing.md](docs/releasing.md). A schema change means a minor bump and an "Upgrade notes" entry in the CHANGELOG.

When trying a build, use a fresh `wip init` in an empty folder: any command of a newer build migrates that project's DB and an older `wip` then refuses it (exit 10).
