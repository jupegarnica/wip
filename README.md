# wip

![wip icon](./web/icon.svg)

**Talk to one agent. It orchestrates a fleet of subagents that run a deterministic flow.**

You talk to one agent — the coordinator. It orchestrates a fleet of subagents that run a deterministic flow: named phases, gates that stop for your decisions, and the subagent each phase runs. Every run, gate and artifact is recorded in the project, so you can audit the work and keep control without asking the model what happened.

Long work with an AI assistant has a memory problem: the plan lives in a chat, a new session starts from zero, and nobody can say which subagent is running or which decision waits on a human. `wip` keeps that state in `.wip/`.

The workflow is not fixed. You create the flows you want by talking to the coordinator: the phases in them, the
instructions for each phase, and an agent for each one with the rules, the model and the write scope you choose.
Flows and agents are Markdown files in the repository, so they are readable, diffable and yours to edit.

## Why wip

- **One agent to talk to.** It orchestrates the fleet of subagents and records what each run did.
- **Deterministic workflows.** Phases, gates and write scopes are declared in Markdown, not improvised.
- **Yours to change.** Create flows and agents by talking to the coordinator; their rules, model and write scope are yours.
- **The work survives the chat.** A new session reads the same state and continues where the last one stopped.
- **You always know what is running and what waits on you.** `wip state` and `wip web` show it without asking the model.
- **Decisions stop instead of guessing.** A gate opens a question and waits for your answer.
- **It stays local.** No network, no daemon, no dependencies: SQLite in the project, definitions in `.claude/` or `~/.claude/`.

## What you get

- **Durable per-project state.** Items, phases, runs, gates and history in `.wip/`, found by walking up from any
  directory.
- **Flows as Markdown.** Phases, gates, agents and write scopes; `wip init` ships four flows — `development`, `ideas`,
  `reports` and `tasks` — covering code, research, documents and decisions.
- **One coordinator, four subagents.** `fast`, `efficient`, `thinker` and `wise` share one contract and differ in how
  much they investigate and decide.
- **A read-only kanban and a quieter transcript.** `wip web` serves the board from the binary; `wip init` also
  installs two optional mods for Claude Code by default (the wizard's last two steps): the Kanban pane and Quiet,
  which hides every transcript row that is neither your messages nor the assistant's text. `--kanban` and `--quiet`
  install them from scripts.
- **Scheduled checks without a daemon.** Flows declare polls; `wip cron` keeps reminders and fixed-time passes, and
  the coordinator arms them when a session starts.
- **Auditable by default.** Every item keeps its runs, gates and history; archiving prunes safely to the system
  trash, never a hard delete.

> **Status:** published as `@garndev/wip` on the npm registry; the current version is at the top of the
> [CHANGELOG](https://github.com/jupegarnica/wip/blob/main/CHANGELOG.md).

## Getting started

### Requirements

Claude Code's `claude` CLI, Node 22.13 or later and npm; a standalone binary can be built from source (see
[docs/install.md](https://github.com/jupegarnica/wip/blob/main/docs/install.md)).

### 1. Install

```sh
npm install -g @garndev/wip
```

### 2. Initialise the project

```sh
cd my-project
wip init
```

The wizard asks six things: the scope (local or `~/.claude/`), the flows to write, the `wip start` command, what
goes into `.gitignore`, and whether to install the Kanban and Quiet mods for Claude Code. See
[docs/init.md](https://github.com/jupegarnica/wip/blob/main/docs/init.md).

### 3. Start the coordinator

```sh
wip start
```

Bare `wip` does the same in a terminal when the project is initialised and a start command is saved. See
[docs/start.md](https://github.com/jupegarnica/wip/blob/main/docs/start.md).

### 4. Ask for work

Write as you would to a colleague: «fix the failing login test», «investigate why the build is slow», «what is
waiting on me?». The coordinator records the item, moves it through the flow and stops at the decisions that are
yours.

### 5. See what is happening

```sh
wip state          # every item, its phase and what it waits on
wip web --open     # the read-only kanban in the browser
wip check          # invariants and warnings
```

## Documentation

| Document                                                                                    | What it covers                                    |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [Install](https://github.com/jupegarnica/wip/blob/main/docs/install.md)                     | npm, binary, upgrade, backup, rollback, uninstall |
| [Init](https://github.com/jupegarnica/wip/blob/main/docs/init.md)                           | `wip init`, scopes, `.gitignore`, the mods        |
| [Start](https://github.com/jupegarnica/wip/blob/main/docs/start.md)                         | `wip start`, saved commands, `WIP_BIN`            |
| [Agents and models](https://github.com/jupegarnica/wip/blob/main/docs/agents-and-models.md) | the four generics, levels, `model:`               |
| [Flows](https://github.com/jupegarnica/wip/blob/main/docs/flows.md)                         | flow format, `wip-flow`, `flow lint`              |
| [Commands](https://github.com/jupegarnica/wip/blob/main/docs/commands.md)                   | the command table, `--json`, exit codes           |
| [Prune](https://github.com/jupegarnica/wip/blob/main/docs/prune.md)                         | `wip prune`, rules, trash, safety                 |
| [Web](https://github.com/jupegarnica/wip/blob/main/docs/web.md)                             | `wip web`, ports, LAN, Docker, logs               |
| [Polling](https://github.com/jupegarnica/wip/blob/main/docs/polling.md)                     | scheduled checks, states                          |
| [Cron](https://github.com/jupegarnica/wip/blob/main/docs/cron.md)                           | reminders and fixed-time passes                   |
| [Coordinating](https://github.com/jupegarnica/wip/blob/main/docs/coordinating.md)           | session start, attention, kanban                  |
| [Releasing](https://github.com/jupegarnica/wip/blob/main/docs/releasing.md)                 | the maintainer's release process                  |
| [CLAUDE.md](https://github.com/jupegarnica/wip/blob/main/CLAUDE.md)                         | developing this repository                        |

## License

MIT. See [LICENSE](https://github.com/jupegarnica/wip/blob/main/LICENSE).
