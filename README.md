# wip

Per-project workflow state for coding agents.

`wip` is a small CLI that keeps, inside your project, the state of the work an AI coordinator runs on your behalf:
which items exist, which phase of which flow each one is in, which subagent is running, which decision waits on
you. The coordinator (any agent harness that can run a shell) drives it with `wip` commands; you read the result in
the terminal or in a read-only kanban (`wip web`).

- **State** lives in `.wip/` (SQLite, git-ignored), found by walking up from the current directory.
- **Definitions** live in one folder, `.agents/` or, with Claude Code, `.claude/` (versioned): `agents/` holds the
  coordinator and four generic subagents; `skills/` holds the coordinator's skills, the subagents' protocol and the
  flows, each flow a skill `wip-flow-<name>`.
- No network, no daemon, no runtime dependency: one binary per platform.

## Install

`@garndev/wip` is not published to the npm registry yet. It is built as one npm package per platform
(`@garndev/wip-<os>-<arch>`, holding the binary), installed as an optional dependency of `@garndev/wip`, which only
holds a small Node launcher. Supported platforms: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`,
`windows-x64`.

### From the tarballs

Build them (see [Development](#development)) and install the main tarball plus the one for your platform:

```sh
bun scripts/build.ts --targets host --out dist --pack
npm install -g dist/garndev-wip-0.1.0.tgz dist/garndev-wip-darwin-arm64-0.1.0.tgz
wip --version
```

npm needs no registry for this: add `--offline` to be sure it does not try one. To try it without touching your
global npm, install into a throwaway prefix with `--prefix <dir>` and run `<dir>/bin/wip` (`<dir>\wip.cmd` on
Windows).

If `wip` says it cannot find its platform package, the platform package is missing: it was installed with
`--omit=optional` (or `--no-optional`) and not passed explicitly, or your platform is not supported. Reinstall it, or
point `WIP_BINARY_PATH` to a `wip` binary.

### The binary alone

The binary inside a platform package (`package/bin/wip`, `wip.exe` on Windows) runs on its own, without Node or
Bun. Extract it from its tarball and put it anywhere in your `PATH`:

```sh
tar -xzf garndev-wip-linux-x64-0.1.0.tgz package/bin/wip
install package/bin/wip ~/.local/bin/wip
```

On macOS the binaries are signed ad hoc; on Windows, `wip.exe` works in PowerShell and `cmd`.

## Start a project: `wip init`

```sh
cd my-project
wip init                          # definitions in .agents/; or: wip init <path>
wip init --harness claude-code    # definitions straight in .claude/
```

`wip init` creates, with `<defs>` being `.agents` (or `.claude` with `--harness claude-code`):

| Path                                             | What                                                                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `.wip/`                                          | the state; added to `.gitignore`                                                                                |
| `.wip/config.json`                               | `defs_dir` (the definitions folder) and `harness`; every command reads the definitions from `defs_dir`          |
| `<defs>/agents/wip.md`                           | the coordinator: the only agent that talks to you                                                               |
| `<defs>/agents/{fast,efficient,thinker,wise}.md` | the four generic subagents                                                                                      |
| `<defs>/skills/wip-coordinate/`                  | how the coordinator runs a flow: cycle, launch prompt, gates, agent choice, model onboarding, runtime interface |
| `<defs>/skills/wip-new-flow/` · `wip-new-agent/` | how the coordinator creates or changes a flow or an agent; `wip-new-flow/example.md` is a reference flow        |
| `<defs>/skills/wip-subagent-protocol/`           | the contract every subagent follows; the coordinator never applies it to itself                                 |
| `<defs>/skills/wip-flow-tasks/`                  | the default flow, `tasks`, in three stages: preparation, execution and review (see «Flows»)                     |

It never overwrites: a second run says `exists` for each file and changes nothing. `--force` rewrites the files that
carry a `wip:` mark in their frontmatter (every file `wip init` writes), copying each one first to
`.wip/backups/defs/`, and keeps the `model:` line of the generic agents and the coordinator; any other edit stays
only in the backup. A file at one of those paths without a `wip:` mark is another tool's: `wip init` exits 3 without
writing anything and names it, also with `--force`.

A project keeps its definitions folder. An init that would write to another one (`wip init --harness claude-code` on
a project set up in `.agents/`, or the other way round) exits 3 and writes nothing; wip never moves definitions.

### `--harness claude-code`

Claude Code reads agents from `.claude/agents/` and skills from `.claude/skills/`, so `--harness claude-code` writes
the definitions there directly, with no `.agents/` and no links. Other tools' agents and skills in `.claude/` stay
where they are, next to wip's; a name clash with a file without the `wip:` mark is exit 3. Then:

```sh
claude --agent wip
```

The coordinator's `initialPrompt` is the session's first message, so it runs its start protocol at once. The
generic agents preload the protocol skill through their `skills` frontmatter key.

Any other `--harness` value, or none, writes `.agents/`, and `wip init` prints how to point the harness at it.

## The four generic agents and model onboarding

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
which `wip init` leaves empty on purpose and `wip init --force` keeps. Until it is set, `wip check` reports the
warning `models_unset` (exit code unchanged), and on its first run the coordinator asks you which model each one
uses, itself included, writes `model:` with a backup in `.wip/backups/defs/agents/`, and checks the result with
`wip flow lint` and `wip check`. The coordinator's own model applies when you restart the session. The choice is
versioned in the definitions folder: whoever clones the project is not asked again. To change a model later, ask the
coordinator, or edit the line yourself.

What happens with `model:` in each harness:

- **Claude Code** reads it from `.claude/agents/`. It accepts an alias (`haiku`, `sonnet`, `opus`), `inherit` or a
  full model ID. For a generic agent, `inherit` is the coordinator's model; for the coordinator, it is the model
  `claude` is started with. `claude --agent wip` reads the coordinator's `model:` when it starts, so a change to it
  needs a restart. If the running session does not pick up a generic's change, open `/agents` or restart it.
- **A harness that takes its subagents' model from its own configuration** ignores the line; it stays in the
  definitions for the harnesses that read it.
- **A harness without subagents**: the coordinator runs every phase itself, on its own model; the recommended answer
  is `inherit` for the four.

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
The reference of every key (`id_pattern`, `fields` and their types, `links`, `stage`, `gate`, `waiting_default`,
`agent`, `writes`) is in `<defs>/skills/wip-new-flow/SKILL.md`, and `wip-new-flow/example.md` is a complete flow
to copy from (it is not a flow itself: only folders named `wip-flow-*` are).

The default flow, `tasks`, is generic: the same phases carry code, an investigation, a document or a decision,
grouped in three stages.

| Stage         | Phases                         | What happens                                                                                                                               |
| ------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `preparation` | `intake` → `research` → `plan` | the request; context, sources and options (skipped when clear); a plan that fixes what is delivered and how it is checked, approved by you |
| `execution`   | `execute` → `check`            | the deliverable; its check against the plan's criteria, back to `execute` when red                                                         |
| `review`      | `review` → `deliver` → `done`  | you validate the result; `deliver` only when something is written outside the project (a pull request, a message, a ticket)                |

To create a flow, ask the coordinator («create a flow for reviews with these phases…»): it follows `wip-new-flow`
(proposal, your approval, backup, write, `wip flow lint`, restore if the lint fails). By hand:

```sh
mkdir .agents/skills/wip-flow-review
cp .agents/skills/wip-new-flow/example.md .agents/skills/wip-flow-review/SKILL.md   # then edit it
wip flow lint review                               # exit 0, or one line per problem and exit 1
wip phase R1 intake --flow review
wip state --flow review
```

`wip flow lint` checks the frontmatter (`name` equal to the folder, a `description`), the block's schema, that
every phase is reachable, one terminal phase, `next` targets, `waiting_default`, `links` patterns, that each `agent:`
exists in `<defs>/agents/` with a `name` and a `description`, that `writes` is `artifacts` or `project`, and that no
live item sits in a phase the file removes.
Each valid version is stored when a command loads it: if a later edit breaks the file, `flow lint` fails, and every
other command keeps using the last valid version with a `flow_invalid` warning until the file is fixed.

## The commands

| Command                                         | What                                                          |
| ----------------------------------------------- | ------------------------------------------------------------- |
| `wip init`                                      | create `.wip/` and the definitions                            |
| `wip phase <ID> <phase> [--flow F]`             | create an item, or move it along its flow's `next`            |
| `wip set <ID> key=value …`                      | set fields (`int +N`, `list +a/-a`, `ts now/none`)            |
| `wip wait <ID> user\|external\|none\|agent:<a>` | record who the item waits on                                  |
| `wip agent start\|stop <ID> …`                  | record a subagent run                                         |
| `wip gate open\|close <ID> …`                   | open or close a decision for the user                         |
| `wip log <ID> "<text>"`                         | add a note to the item's history                              |
| `wip show <ID>`                                 | one item with its runs, gates, history and totals             |
| `wip state [--attention]`                       | every item and what it waits on                               |
| `wip archive <ID>`                              | archive an item with nothing running nor open                 |
| `wip session start`                             | a coordinator (re)starts: runs left running become `orphaned` |
| `wip check [<ID>]`                              | the invariants (exit 1 on findings) and the warnings          |
| `wip flow lint [<flow>]`                        | validate the flows                                            |
| `wip web [status\|stop\|log]`                   | the kanban: serve it, check it, stop it, read its log         |

Every command accepts `--json` (envelope `{ok, item, events, warnings, message, data}`) and `--help`. Exit codes:
0 ok · 1 findings · 2 usage · 3 rejected · 4 not found (or no `.wip/`) · 10 database. `WIP_HOME` points the CLI at
another project, only if that directory contains a `.wip/`.

## `wip web`

```sh
wip web            # http://localhost:39100/ (WIP_WEB_PORT or --port to change it)
wip web --local    # only on 127.0.0.1
wip web --open     # and open http://localhost:<port>/ in the browser
wip web status     # is this project's wip web up? prints its URL
wip web stop       # stop this project's wip web
wip web log -n 20  # the last lines of its log; --follow keeps printing
```

A read-only kanban of the project, served from the binary with nothing external: one board per flow (columns by
`stage` or by phase; each stage in one blue, more transparent stage after stage, with readable text in the light and
dark themes, and no colour for a phase without a stage), «Your turn», open gates, running agents, the history with archived items, each item's runs,
gates and artifacts (Markdown rendered; every artifact is served with a `sandbox` CSP). Requests with a foreign
`Host` header are rejected. Running it again for the same project reports the running one and exits 0 (with
`--open`, it opens the browser on it); a port held by another project's `wip web` or another program is exit 3.
Ctrl-C or `wip web stop` stops it. If no browser opens (`open`, `xdg-open` or `start` fails), `--open` prints a
warning and the server keeps serving.

While it serves, `.wip/web.pid` holds its PID and port, and `.wip/logs/web.log` gets the start with its
addresses, every response with status ≥ 400, every error and the stop; past 1 MB the log moves to `web.log.1`.
`status` and `stop` identify the server by its `/health`, which names the project, and take the port from
`--port`, `WIP_WEB_PORT`, `.wip/web.pid` or 39100, in that order.

Exit codes:

- `wip web status`: 0 this project's `wip web` answers · 1 nothing answers · 3 another project or program holds the
  port.
- `wip web stop`: 0 stopped (SIGTERM, then it waits up to 10 s) · 1 nothing answers (a stale `web.pid` is removed) ·
  3 another project or program holds the port, or it did not stop. It never signals a process of another project or
  one that is not `wip web`.
- `wip web log`: 0 · 4 no log yet.

**LAN:** without `--local`, `wip web` also listens on your private LAN address and prints it as `LAN:`. Anyone on
that network can then read the board and the item artifacts, with no authentication. Use `--local` on networks you
do not trust.

## Coordinating from any agent

wip never calls a harness: the coordinator calls wip. Any agent harness can coordinate if it can:

1. run `wip …` in a shell and read its output (required);
2. read and write project files (required);
3. load the agent `wip` and the skills as instructions; otherwise paste `<defs>/skills/wip-coordinate/SKILL.md`
   into a session as its first message;
4. launch, stop and collect background subagents; otherwise the coordinator runs each phase itself, in the
   foreground, following the agent's `.md`;
5. ask the user a question with options; otherwise the gate is a text block with numbered options, answered in the
   next turn.

The **Runtime interface** section of `wip-coordinate` maps those capabilities to Claude Code's tools and says what
to do without each one. On the first message of every session, whatever it says (with Claude Code, the
coordinator's own `initialPrompt`), the coordinator starts with
`wip session start`, `wip state --attention` and `wip check`, and never relaunches a run it finds `orphaned`: it
tells you. It also asks `fast`, in the background, to bring up the kanban. `fast` looks for this project's
`wip web` (the port in `.wip/web.pid`, then `wip web status --port <N>` on 39100 to 39109); if one is up, no second
one starts. Otherwise it runs `wip web --open --port <N>`, which opens the browser, on the first of those ports that
nothing answers; a port held by another project or program is skipped silently. You get one line with the URL and
the port, and a warning only when none of the ten ports is free or the start fails. Later checks use that port.
When one finds the kanban down or its log with errors, the coordinator tells you; it starts it again or stops it
only when you ask.

## Development

Requires the Bun version in `.bun-version`.

```sh
bun install
bunx tsc --noEmit
bunx biome check .
bun test                       # unit and e2e, the CLI in-process
bun src/cli.ts --version       # the CLI from source
```

**Build.** `scripts/build.ts` compiles one binary per target with `bun build --compile` and writes the npm packages;
`--pack` also runs `npm pack` on each:

```sh
bun scripts/build.ts --targets host --out dist --pack   # or --targets all, or darwin-arm64,linux-x64,…
```

It leaves in `dist/` the six tarballs (`garndev-wip-<version>.tgz` and `garndev-wip-<os>-<arch>-<version>.tgz`) and
the package folders under `dist/npm/`. Everything that `wip init` writes (`templates/`) and that `wip web` serves
(`web/`, `@garndev/markdown`) is embedded in the binary; a test fails if a file in those folders is missing from its
manifest.

**End-to-end against the binary.** The e2e tests run the CLI in-process unless `WIP_BIN` names a binary, and
`test/e2e/pack.test.ts` only runs with `WIP_PACK_DIR`: it builds the host tarballs there (if they are not there
yet), installs them with npm into prefixes inside that folder (`--offline`, with and without `--omit=optional`, and
without the platform package) and runs the installed `wip` and the bare binary with neither Node nor Bun in `PATH`.

```sh
WIP_PACK_DIR=/tmp/wip-pack bun test test/e2e/pack.test.ts
WIP_BIN=/tmp/wip-pack/npm-prefix/bin/wip bun test test/e2e
```

**CI.** `.github/workflows/ci.yml` (tests on Linux, macOS and Windows, the five binaries, a smoke test of each on
its platform) only runs by hand for now (`workflow_dispatch`).

All `package.json` files are `"private": true`: nothing is published to npm yet.
