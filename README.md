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
npm install -g ./dist/garndev-wip-0.1.0.tgz ./dist/garndev-wip-darwin-arm64-0.1.0.tgz
wip --version    # 0.1.0 (v1 d5a93ec, built 2026-11-01T10:20:31Z): branch, commit and build date
```

Write the tarball paths with `./` (or absolute): npm reads `dist/x.tgz` without it as the GitHub repository
`dist/x.tgz` and fails with a git error. npm needs no registry for this: add `--offline` to be sure it does not try
one. To try it without touching your global npm, install into a throwaway prefix with `--prefix <dir>` and run
`<dir>/bin/wip` (`<dir>\wip.cmd` on Windows), or use `bun run install:local` (see [Development](#development)).

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

`wip init` also creates the items a flow lists under `seed` in its block, and copies each seed's `files` from the
flow's skill folder into the item's artifact directory. The `tasks` flow seeds one, `onboarding` («Get to know wip»),
in `intake` and waiting on you, with the artifact `guide.md`: everything you can do with wip, the kanban included.
On the first start the coordinator only tells you, in its `What next?` line, that you have an onboarding task. When
you want to start, it gives you the links to the guide (`view/item/tasks/onboarding/artifact/guide.md` on the
kanban) and to the item's panel, answers your questions from the guide, and closes the item at a real gate («Close
the onboarding?») in `done`, archived. An ID that already exists, open or archived, is never touched: a second init
or `--force` neither duplicates nor revives it, nor rewrites its files.

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

- **Claude Code** reads it from `.claude/agents/`. It accepts an alias (`haiku`, `sonnet`, `opus`, `fable`), `inherit`
  or a full model ID. For a generic agent, `inherit` is the coordinator's model; for the coordinator, it is the model
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
mkdir .agents/skills/wip-flow-review
cp .agents/skills/wip-new-flow/example.md .agents/skills/wip-flow-review/SKILL.md   # then edit it
wip flow lint review                               # exit 0, or one line per problem and exit 1
wip phase R1 intake --flow review
wip state --flow review
```

`wip flow lint` checks the frontmatter (`name` equal to the folder, a `description`), the block's schema, that
every phase is reachable through `next` or `from_any`, one terminal phase, `next` targets, `waiting_default`, `links` patterns, that each `agent:`
exists in `<defs>/agents/` with a `name` and a `description`, that `writes` is `artifacts` or `project`, that each `polling` entry names an existing phase and agent and has a valid
cadence, and that no live item sits in a phase the file removes.
Each valid version is stored when a command loads it: if a later edit breaks the file, `flow lint` fails, and every
other command keeps using the last valid version with a `flow_invalid` warning until the file is fixed.

`wip flow disable <flow>` switches a flow off in this copy of the project (a flag in `.wip/wip.sqlite`, no file
changes): its items leave `wip state`, `wip check`, the polls and the board, and every write on them exits 3.
`wip show <ID>` still shows them with a `flow_disabled` warning. `wip flow enable <flow>` brings it back; `wip flow lint` lists the disabled flows.

## The commands

| Command                                         | What                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| `wip init`                                      | create `.wip/` and the definitions                                          |
| `wip phase <ID> <phase> [--flow F]`             | create an item, or move it along its flow's `next` or to a `from_any` phase |
| `wip set <ID> key=value …`                      | set fields (`int +N`, `list +a/-a`, `ts now/none`)                          |
| `wip wait <ID> user\|external\|none\|agent:<a>` | record who the item waits on                                                |
| `wip agent start\|stop <ID> …`                  | record a subagent run                                                       |
| `wip gate open\|close <ID> …`                   | open or close a decision for the user                                       |
| `wip log <ID> "<text>"`                         | add a note to the item's history                                            |
| `wip show <ID>`                                 | one item with its runs, gates, history and totals                           |
| `wip state [--attention]`                       | every item and what it waits on                                             |
| `wip archive <ID>`                              | archive an item with nothing running nor open                               |
| `wip session start`                             | a coordinator (re)starts: runs left running become `orphaned`               |
| `wip check [<ID>]`                              | the invariants (exit 1 on findings) and the warnings                        |
| `wip flow lint [<flow>]`                        | validate the flows; lists the disabled ones as `DISABLED <flow>`            |
| `wip flow disable\|enable <flow>`               | hide a flow and freeze its items, or bring it back                          |
| `wip poll due\|record\|seen`                    | the flows' scheduled checks: what is due, record a pass, what a pass saw    |
| `wip web [status\|stop\|log]`                   | the kanban: serve it, check it, stop it, read its log                       |

Every command accepts `--json` (envelope `{ok, item, events, warnings, message, data}`) and `--help`. Exit codes:
0 ok · 1 findings · 2 usage · 3 rejected · 4 not found (or no `.wip/`) · 10 database. `WIP_HOME` points the CLI at
another project, only if that directory contains a `.wip/`.

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
gates and artifacts (Markdown rendered; every artifact is served with a `sandbox` CSP). Requests with a foreign
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
tells you. It also asks `fast`, in the background, to bring up the kanban: `wip web status` says whether this
project's `wip web` is up; if it is, no second one starts. Otherwise `fast` runs `wip web --open`, which takes the
first free port from 33333 and opens the browser. You get one line with the URL and the port, and a warning only
when the start fails. When a later `wip web status` finds the kanban down or its log with errors, the coordinator
tells you; it starts it again or stops it only when you ask.

## Development

Requires the Bun version in `.bun-version`.

```sh
bun install
bunx tsc --noEmit
bunx biome check .
bun test                       # unit and e2e, the CLI in-process
bun src/cli.ts --version       # the CLI from source: 0.1.0 (source)
```

**Build.** `scripts/build.ts` compiles one binary per target with `bun build --compile` and writes the npm packages;
`--pack` also runs `npm pack` on each:

```sh
bun scripts/build.ts --targets host --out dist --pack   # or --targets all, or darwin-arm64,linux-x64,…
```

It leaves in `dist/` the main tarball (`garndev-wip-<version>.tgz`) and one tarball per target
(`garndev-wip-<os>-<arch>-<version>.tgz`: two files with `--targets host`, six with `--targets all`) and the package
folders under `dist/npm/`. Everything that `wip init` writes (`templates/`) and that `wip web` serves
(`web/`, `@garndev/markdown`) is embedded in the binary; a test fails if a file in those folders is missing from its
manifest.

`scripts/build.ts` fixes the branch, the short commit, whether the tree is dirty (untracked files count) and the build
date into the binary; `SOURCE_DATE_EPOCH` sets the date. Without git they read `no git`. `wip version --json`
returns them as `branch`, `commit`, `dirty`, `built_at` and `source` (true when run from source), next to `version`.

**Try the build locally.** `bun run install:local` builds the host tarballs into `dist/` and installs them with npm
into `dist/local`, without the registry and without touching your global npm; run `dist/local/bin/wip`.
`--prefix <dir>` installs elsewhere (for example `--prefix ~/.local/wip-dev`), `--out <dir>` builds elsewhere.

```sh
bun run install:local                 # then dist/local/bin/wip --version
mkdir /tmp/wip-try && cd /tmp/wip-try && <repo>/dist/local/bin/wip init
```

Any command of a newer build migrates the database of the project it opens, and an older `wip` then refuses it
(exit 10), so try it in a project made with `wip init` in an empty folder, not in one your installed `wip`
still uses. `wip --version` prints the branch, the commit, a `-dirty` mark and the build date, so two builds of
the same version can be told apart. Without npm, point a link at
the binary (`ln -s <repo>/dist/npm/wip-<os>-<arch>/bin/wip ~/.local/bin/wip-dev`), or run one command of an
installed launcher against it with `WIP_BINARY_PATH=<absolute path to the binary> wip …`.

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
