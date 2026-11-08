# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`wip` (`@garndev/wip`) is a Bun/TypeScript CLI that keeps, per project, the state of the work an AI coordinator runs: items, the phase of each in a flow, running subagents, gates waiting on the user. State is SQLite in `.wip/` (git-ignored); there is also a read-only kanban (`wip web`). It ships as one npm package that runs on Node ≥ 22.13 (`dist/npm/wip`, a JavaScript bundle and a bin, no dependencies) and, optionally, as standalone binaries built locally with `--targets` (CI does not build them); both come from the same `src/`. `README.md` is the full user-facing spec (commands, flows, polling, exit codes) and is the reference when behavior is in doubt.

## Commands

Bun version is pinned in `.bun-version`; the test root is `test/` (`bunfig.toml`).

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
bun run install:local --node          # npm-install the package as wip2 into dist/local (without --node: the binary)
```

CI (`.github/workflows/ci.yml`, on push to `main`/`v1` and pull requests) runs typecheck, lint and `bun test` on Linux/macOS/Windows, packs the npm package (`npm publish --dry-run`) and runs `test/e2e` against it on Node 22, 24 and 26 (`WIP_TEST_BIN=<package>/bin/wip.mjs`). `.github/workflows/release.yml` (tag `v<version>`, or `workflow_dispatch` as a dry run) reuses it, publishes the tested tarball to npm behind the `npm-publish` environment and makes the GitHub Release (CHANGELOG notes, no assets). Neither workflow builds binaries; `docs/future-improvements.md` says how to bring them back.

**Release rule.** Never push a tag, publish to npm or create a GitHub Release without the user's explicit approval; follow `docs/releasing.md`. A schema change means a minor bump and an "Upgrade notes" entry in the CHANGELOG.

When trying a build, use a fresh `wip init` in an empty folder: any command of a newer build migrates that project's DB and an older `wip` then refuses it (exit 10).

## Architecture

**Runtime.** `src/` must run on Node and on Bun: it uses only `node:*` modules (Biome forbids `bun:*` and `Bun.*` there; `test/unit/runtime-agnostic.test.ts` also forbids `import.meta.main`/`dir`). SQLite goes through `src/sqlite.ts` (a thin wrapper over `node:sqlite` with the bun:sqlite shape: `query().get/all/run`, `get()` → `null`, booleans as 0/1, `transaction().immediate()`), YAML through `src/yaml.ts` (the bundled `yaml` package), the web server is `node:http`. Tests and `scripts/` stay on Bun.

**Command dispatch.** `src/cli.ts` maps command names to `IHandler`s (`src/commands/*.ts`) and `run()` is the single entry point, used by every entry and by tests in-process; `main(argv)` adds the interactive parts and writes the output. `src/main.ts` calls it under Bun and in the binary; the npm package's `bin/wip.mjs` (from `npm/wip/bin/wip.mjs`) calls it on Node. A handler fills an `IResult` (`src/context.ts`) rather than printing; `cli.ts` renders either text `lines` or the JSON envelope (`--json`). Each handler declares `db: "none" | read | write`, which decides how the DB is opened. Errors are `WipError` with an exit code from `src/errors.ts` (0 ok, 1 findings, 2 usage, 3 rejected, 4 not found, 10 DB). Help text lives in `src/commands/help.ts` (`COMMANDS` specs); a new command needs its handler registered, its spec, and its tests.

**State and invariants.** `src/db.ts` opens SQLite (WAL, needs ≥ 3.37), copies a database it is about to migrate to `.wip/backups/db/`, and applies `src/migrations/*.sql`, embedded through `src/embedded/migrations.ts` (add a migration = new `.sql` file _and_ an entry there; `user_version` is the index + 1). `src/items.ts` holds item queries; `src/invariants.ts` checks I1/I2f/I2/I3/I4 of every item against its flow, and `wip check` reports them. `src/clock.ts` is injectable for tests.

**Flows are markdown, not code.** A flow is a skill `wip-flow-<name>` whose SKILL.md carries a block that `src/flow/parse.ts` parses into phases (`kind`, `gate`, `next`, `agent`, `writes`, `from_any`, fields, links, seed items); `src/flow/lint.ts` validates it (reachability, one or more terminal phases, every phase reaching one, etc.) and `src/flow/registry.ts` loads versions from the definitions folder. Agents (`src/agents.ts`) are `.md` files with frontmatter; files that `wip init` writes carry a `wip:` mark in frontmatter, which `--force` and conflict checks rely on.

**Definitions folder.** `.wip/config.json` stores `defs_dir` (`.claude`, or `~/…` for `init --global`, resolved against `HOME`/`USERPROFILE`). Everything reads definitions from there. `src/init/*` scaffolds it, never overwrites files, and never moves or deletes definitions; `init --force` migrates a legacy folder of the same scope to `.claude` and leaves the old one as it is.

**Interactive init.** `wip init` is a synchronous handler fed by flags (`--yes`, `--start`, `--start-default`, `--no-start`); the questions live outside `run()`, like `wip start`'s launch: `src/cli.ts` calls `promptInit` (`src/commands/init.ts`, questions in `src/init/ask.ts`, helpers in `src/init/prompt.ts`) only on a terminal without `--yes`/`--json`, which turns the answers into those flags before `run()`. The `model:` lines come from the templates under `templates/agents/`; init writes them as they are and never asks for or writes a model.

**Pinned binary.** `.wip/config.json` may hold `wip_bin` (absolute, `~/…` or project-relative path); the coordinator runs that executable instead of the global `wip`, so projects can use different versions. `init` preserves it.

**Embedded assets.** `templates/` (what `wip init` writes), `web/` (the kanban UI) and `@garndev/markdown` are inlined into the binary via text imports (`src/embedded/templates.ts`, `src/embedded/web.ts`). Adding a file under `templates/` or `web/` requires adding it to the matching manifest; a test fails if one is missing. `src/web/*` is the `node:http` server for `wip web`.

**Build.** `scripts/build.ts` always writes the npm package `dist/npm/wip/` (`bun build --target node` of `src/cli.ts` into `dist/wip.mjs`, `bin/wip.mjs`, `package.json` from `npm/wip/`, README, LICENSE; it fails if anything else ends up there) and embeds branch/commit/dirty/date (`src/build-info.ts`) with `--define`. `--targets` also compiles binaries (`bun build --compile` of `src/main.ts`) into `dist/bin/<os>-<arch>/`, ad hoc signs darwin ones and archives them with `SHA256SUMS` into `dist/release/`. `bin/wip.mjs` checks Node ≥ 22.13 (exit 2), hides Node 22's SQLite ExperimentalWarning, sets `WIP_LAUNCH_BIN` (not on Windows) and imports the bundle.

## Two copies of the definitions

`templates/` is the **source** of what `wip init` ships (flow `tasks`, the four generic agents, coordinator skills). `.claude/agents` and `.claude/skills` in this repo are this project's own dogfooded definitions (used with `claude --agent wip`) and include flows that are not templates (`dev`, `ideas`). Changing a shipped template does not update `.claude/`, and vice versa; `templates/` is excluded from biome and `test/fixtures/` holds deliberately broken flows and agents used by lint/parse tests.

## Testing notes

Tests call `run()` in-process through helpers in `test/helpers/` (`project.ts` creates scratch projects under the OS temp dir, never a real project or `~/.claude`). JSON output is validated against `test/schemas/*.json`. `test/e2e/` covers init, flows, web servers and packing; `WIP_TEST_BIN` runs it against the npm package or a binary. `build-script`, `install-local` and `launcher` unit tests cover the scripts and `bin/wip.mjs`.
