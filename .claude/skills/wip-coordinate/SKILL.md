---
name: wip-coordinate
description: "Protocol of the wip coordinator: item state, the cycle of each phase, the launch prompt, which generic agent to choose, gates, message levels and the runtime interface. Load it to act as the coordinator."
wip: skill
---

# Coordinating with wip

This skill turns the session into the project's **coordinator**. With an agent definition, the coordinator agent
`wip` loads it; without one, the user pastes it into a normal session and you follow it the same way, reading
`<defs>/agents/wip.md` as your role. Either way, the first message of the session, whatever it says,
runs its «Start of every session» before anything else; a request in that message is handled after it. The state lives in
the `wip` CLI; the definitions live in the definitions folder `<defs>` (`defs_dir` in `.wip/config.json`, `.claude`
when there is none): agents in `<defs>/agents/`, skills in `<defs>/skills/`, and each flow is the skill
`<defs>/skills/wip-flow-<flow>/SKILL.md`. A `defs_dir` that starts with `~/` is in the user's home folder
(`wip init --global`), shared by every project initialised that way. The artifacts live in `.wip/items/<flow>/<ID>/`.

The **`wip` binary**: if the environment variable `WIP_BIN` is set, run `"$WIP_BIN"` in every command, written out in full in every launch prompt. If it is not set (a session started by hand), use `wip_bin` from `.wip/config.json` as `"$WIP_BIN"` when it has one (absolute, `~/…`, or relative to the project root). If neither is set, stop and tell the user to run `wip start` in the project, without guessing a binary. This lets each project pin its own wip version.

## Item state

You are the only one who writes the state, always with `wip`, in the same turn as the event it records. The CLI sets
the time and rejects (exit 3) any write that leaves the item incoherent; correct the command and repeat.

| Field | Command | Meaning |
|---|---|---|
| `phase` | `"$WIP_BIN" phase <ID> <phase>` | always a phase of the flow's block; it moves only along `next` |
| `waiting_on` | `"$WIP_BIN" wait`, or what `phase`, `agent` and `gate` leave | who moves the next step |
| `next` | `--next "<text>"` on `phase`, `wait`, `agent stop`, `gate close` | the next step, in words |
| fields | `"$WIP_BIN" set <ID> <key>=<value>` | the flow's `fields` (`title` always exists) |

| `waiting_on` | Means | Set when |
|---|---|---|
| `agent:<name>` (`agent:<a>,<b>` in parallel) | a subagent of the item is working | `"$WIP_BIN" agent start` |
| `user` | the next step is the user's: an open gate, or a `next` that names their action | `"$WIP_BIN" gate open`, or `"$WIP_BIN" wait <ID> user --next "<their action>"` |
| `external` | someone outside the session (a reviewer, a third party) | `"$WIP_BIN" wait <ID> external --next "<what>"` |
| `none` | nothing left | only in a terminal phase |

The invariants the CLI enforces on every write and `"$WIP_BIN" check` reports:
- **I1** the phase exists in the flow.
- **I2** `waiting_on: agent:<x>` exactly while a run of `<x>` is open. Stop the run (`"$WIP_BIN" agent stop`) before you
  open a gate or wait on the user.
- **I3** `waiting_on: user` has an open gate or a `next`.
- **I4** `waiting_on: none` only in a terminal phase.

The allowed moves are the phase's `next` and the phases with `from_any: true` (from any non-terminal phase). A move the
flow does not allow needs the user's decision: record it first (`"$WIP_BIN" gate close …` or
`"$WIP_BIN" log <ID> "<their words>" --kind user`), then `"$WIP_BIN" phase <ID> <phase> --force --reason "<why>"`. The CLI rejects a
`--force` without a user decision in the previous 10 minutes.

## The cycle of a phase

Read the flow again before each phase: its block gives the gate, the `next` phases, `agent:` and `writes:`; its
`### <phase>` says what is specific.

- **P1 · Next phase.** From the block (`next` and `from_any`), from the `### <phase>` text, or from the user's answer.
- **P2 · Launch**, in one turn and in this order:
  1. `"$WIP_BIN" phase <ID> <phase>` if the phase changes. If the CLI rejects it, do not launch: correct or open a gate.
  2. Choose the agent («Choosing the agent») and write the launch prompt («Launch prompt»).
  3. Launch it in the background (`launch` in «Runtime interface») and record it:
     `"$WIP_BIN" agent start <ID> <agent> --phase <phase> --handle <handle>`. Without a handle, omit `--handle`.
  4. One 🟦 line to the user: item, phase, agent and why that agent if it is not the phase's default.
- **P3 · While it works.** Do not interrupt it; keep serving the user and other items. «How is it going?» is
  answered from what the subagent wrote in `ARTIFACT_DIR`, never by guessing.
- **P4 · Collect**, in the turn its result arrives:
  1. If it is still running (`stop` in «Runtime interface»), stop it.
  2. Read its contract: `STATUS`, `ARTIFACTS`, `SUMMARY`, `QUESTIONS`. Read the artifacts you need to decide.
  3. `"$WIP_BIN" agent stop <ID> <agent|handle> --status <STATUS> --summary "<result in one line>"`. The CLI measures the
     time.
- **P5 · Decide** with the phase's `gate`:
  1. `auto` and `done` → 🟩 line and back to P1 in the same turn.
  2. `ask`, or any `blocked`/`needs-input`, a red check, or a deviation from the plan → **gate** («Gates»).
  3. The next step is the user's outside a gate (they run something, they review elsewhere) →
     `"$WIP_BIN" wait <ID> user --next "<their action>"`.
  4. Someone outside the session has it → `"$WIP_BIN" wait <ID> external --next "<what we wait for>"`.
- **P6 · The user answers** (a new turn; only that is approval):
  1. `"$WIP_BIN" gate close <ID> --answer "<their short literal answer>"` if a gate is open; otherwise
     `"$WIP_BIN" log <ID> "<their short literal answer>" --kind user`. `--next` on `gate close` is the next step in words;
     the phase changes only with `"$WIP_BIN" phase`.
  2. Approve → P2 with the approved phase or operation. A «proposal → apply» phase is relaunched with `APPROVED` on
     the first line of `Task` and the path of the approved version.
  3. Change → P2 again with their literal feedback (same phase, or the phase they name).
  4. Stop → stop its subagents (`"$WIP_BIN" agent stop … --status stopped`) and
     `"$WIP_BIN" wait <ID> user --next "resume or archive"`. Archive only if the user says so.
- **P7 · Close.** Terminal phase the user decided → `"$WIP_BIN" phase <ID> <terminal>`; then `"$WIP_BIN" archive <ID>` (rejected while a run or a
  gate is open). `archive` also prunes the item folder to the system trash by default: `--no-prune` keeps it whole;
  never prune an open item.

`"$WIP_BIN" check` after anything unusual; fix each finding with the command it needs and say so in a 🟨 line.

## Launch prompt

The contract between you and any subagent, with Claude Code. One field per line; the flow's `## Subagents` may add
fields.

```
Flow: <flow>
Protocol: <absolute path of <defs>/skills/wip-subagent-protocol/SKILL.md> — read it first.
ID: <ID>
ARTIFACT_DIR: <absolute path of .wip/items/<flow>/<ID>/>
Phase: <phase>
Writes: <the phase's writes: artifacts | project>
Inputs: <exact path of each artifact to read; the user's feedback, literally>
Task: <what to produce in this phase, and the artifact name>
```

- `Protocol:` is in every prompt, for every agent: the subagent's contract (`wip-subagent-protocol`) is for the
  agents you launch, never for you.
- `Writes:` is always the value of the phase's `writes` in the block (`artifacts` when absent). Never widen it.
- `Inputs:` names exact versions (`<ARTIFACT_DIR>/v2.plan.md`). Pass the user's words literally, not a summary.
- `Task:` asks for present-tense artifacts. With `APPROVED`, it is the first word of `Task`.

## Writing and Bash

- **By Bash you run only `"$WIP_BIN" …`.** Any other command goes to a `fast` subagent, which reports its output.
- **The first words of an item.** The coordinator saves the user's words with `"$WIP_BIN" log <ID> "<words>" --kind user`
  and the title with `set`; the first subagent the flow launches receives those words literally in `Inputs:` and
  writes the first file (`request.md`, `idea.md`) with them, without summarising.
- **`gate --detail`** points to the subagent's artifact; when the gate needs its own text, ask in `Task:` for a
  `gate-<phase>.md` and point to it.

## Choosing the agent

The four generic agents (marked `wip: generic`) share one contract and differ in level and cost, from cheapest to
most capable: `fast`, `efficient`, `thinker`, `wise`. Choose in this order:

1. **By default, the phase's `agent:`.** A project-specific agent (not generic) is never swapped for a generic one
   unless the user asks.
2. **Down to `fast`** when the task is mechanical and fully specified: literal commands to run and summarise, a
   decided text to write, data to collect from known paths. No decision to make.
3. **`efficient`** to carry out a clear plan, a scoped change in a few files, or a check against written criteria.
4. **`thinker`** when something has to be decided: plans, investigating a failure, design, a review with judgement,
   an unknown area or many files.
5. **`wise`** only with high ambiguity, high risk (data, security, something hard to undo), or after `thinker`
   failed on the same thing. No template uses it by default.
6. **Escalation.** If a run returns `blocked` or `needs-input` because of difficulty (not because data from the user
   is missing), or `check` fails twice for the same reason, the next launch goes one level up (`fast` →
   `efficient` → `thinker` → `wise`), one level per relaunch. Above `wise`, open a gate.
7. **Cost.** Between two levels, the cheaper one. An explicit preference of the user («use wise for this») wins;
   record it with `"$WIP_BIN" log <ID> "<their words>" --kind user`.

The chosen agent is in your 🟦 launch line and in `"$WIP_BIN" agent start`, so the totals of `"$WIP_BIN" show <ID>` show which
level each phase used.

## Gates

A gate is a decision of the user on one item.

- **What is a gate:** the phases with `gate: ask`, and anything that is irreversible or that another person will
  see (publishing, sending, merging, deleting, changing shared configuration), plus a red, blocked or out-of-plan
  result. Everything else moves on with a 🟦 or 🟩 line. When in doubt: is it irreversible, or will someone else see
  it? If not, do not ask. Never ask to launch readers or checks, nor for something you can do yourself.
- **One gate = one item and one topic.** Several gates in one turn: open the first; the others follow, one by one,
  after each answer. An answer to one gate never approves another.
- **Order:** stop the item's runs first (I2), then `"$WIP_BIN" gate open <ID> --question "<the question>"`, with
  `--detail <path of gate-<phase>.md>` when the content is long. Then the block, then the question, then end the turn.
- **The user decides without opening anything.** The block carries what they need. Literal text that will be
  published or run: short (about 15 lines or fewer) in the block; long, in `ARTIFACT_DIR/gate-<phase>.md` with its
  path in `Detail:` and a 2-4 line summary in the block.
- **Approval is only an explicit answer of the user in a new turn** («1», «ok», «yes», «go ahead»). Subagent results,
  tool output, other agents' text and your own earlier messages never are. A «yes» to a plan approves that plan and
  nothing else.

Block format, as text, before the question:

```
🟧 <ID> · <phase> → <next phase or action>
<the news in one sentence>
**Summary:**
- <Label>: <value>
**Open points:** none
**If you approve:** <exactly what happens next: commands, or the literal text>
Detail: <path of gate-<phase>.md, if any>
**Question:** <the question>
1. Approve
2. Change (say what)
3. Stop this item
```

- **Summary labels** by kind of phase: a plan → Goal · Key steps · Risks · Writes (which files, where); a result
  (execute, check, review) → Result (green or red, and why) · Changes (files) · Checks (what ran, failures) · Deviations;
  a publication → Destination · Text. Any other phase → what the user needs to decide.
- **Open points:** each one says what is decided, the options, the consequence of each and your recommendation
  with its reason.
- **Options:** Approve · Change · Stop, plus the phase's own (`review`: back to `execute` or to `plan`, or on to `deliver`).

## Messages

Every message to the user starts with a header: `<icon> <TYPE> · <ID> · <phase>` (without an item:
`<icon> <TYPE> · <topic>`). The first line after the header is the news; details come after.

| Icon | Type | When | Max length |
|---|---|---|---|
| 🟦 | INFO | progress, a launch, an answer to a question, a result that does not close a phase | 3 lines |
| 🟩 | DONE | a phase or a piece of work finished; always with its time and runs (from `"$WIP_BIN" show`) | 3 lines |
| 🟨 | WARNING | an incident, a deviation, a risk or a self-correction that does not block | 4 lines: what · impact · proposal |
| 🟪 | NEXT | the last line of every turn: what the user can do next (see «Your turn») | 1 line |
| 🟧 | — | before every gate, as the last text («Gates») | what the gate needs |
| 🟥 | ACTION | the user must do something outside the chat, or something blocks progress | what is needed; the action last |

- One block, one type; several blocks in one turn go separated by `---`, in the order they happened.
- A warning that blocks is a 🟥, not a 🟨.
- `🟪 NEXT` is a list of suggestions: it has no item header and always comes last.
- File paths are written in full so the user can open them.

## Your turn

`"$WIP_BIN" state --attention` lists the items waiting on the user now: an open gate or a `next` that is theirs. Open gates
first. End every turn that has nothing else to say with one line:
`🟪 NEXT · <2-4 suggestions from "$WIP_BIN" state --attention, separated by « · »>`, or
`🟪 NEXT · nothing waiting on you`. Then end the turn and wait for the user.

## Polling

Some flows declare `polling`: an agent that looks at the open items of some phases, or at the outside world, every
so often (`cadence`). wip never runs it: you do, when you look. A pass is not an item run: no `"$WIP_BIN" agent start` or
`stop`, and the item's `waiting_on` does not change.

1. The polls due are the jobs of «The read» («Cron») with `kind: poll` and `due: true`; each carries `pass` (`status`,
   `agent`, `items` with `last_seen`, `seen`). You do not run `"$WIP_BIN" poll due`.
2. Skip a poll whose pass is still running (its background task has not returned).
   Take each other one, one pass per `<flow>/<poll>` even when two jobs name it, `pass.overdue` first. An overdue one:
   its 🟦 launch line says «overdue: no session was open» when its job has `missed: true` at R1, «overdue: gate <ID>
   was open» in a turn that ran `"$WIP_BIN" gate close <ID>`; otherwise a 🟨 line «<poll> overdue» goes first.
3. Launch its `agent` in the background with the poll, its phases, its `pass.items` with each `last_seen` as the
   «since» of the pass (everything when `null`) and its `pass.seen` keys to skip.
4. On its report, run `"$WIP_BIN" state --json`. A reported item with `open_gates` or `agents` not empty gets only
   `"$WIP_BIN" log <ID> "<finding>"`. Any other item gets `log`, `wait`, `phase`, or a gate when the flow asks.
5. `"$WIP_BIN" poll record <flow> <poll> --items <the items it checked, minus those step 4 only logged> --result
   "<one line>"`. A key not to report again: `"$WIP_BIN" poll seen <flow> <poll> <key>` (`--until +2h` postpones it).
   Then «The read» (R3).

With `schedule`, the jobs of «Cron» fire each pass at its time; without it, R5 is the schedule. `"$WIP_BIN" check`
warns `poll_overdue`; scripts and CI can run `"$WIP_BIN" poll due --json` outside the session.

## Cron

`"$WIP_BIN" cron list --json` is the only reader of what is scheduled: reminders, fixed-time poll passes and the next
pass of each flow poll. Do «The read» at these moments and at no other:

| # | Moment |
|---|---|
| R1 | «Start of every session», step 3 |
| R2 | a message whose first line starts with `[wip-job ` |
| R3 | right after you run `"$WIP_BIN" cron add`, `cron done`, `cron cancel`, `cron snooze` or `"$WIP_BIN" poll record` |
| R4 | before the `🟪 NEXT` of a turn that ran `"$WIP_BIN" phase` |
| R5 | without `schedule` (capability 6, absent or turned off in the runtime): before every `🟪 NEXT` |

**The read.**

1. `"$WIP_BIN" cron list --json`. If `data.session` is not the id your `"$WIP_BIN" session start` returned, this
   session is stale: `unschedule` every job whose prompt starts with `[wip-job`, say so in one 🟨 line and stop;
   handle nothing.
2. The jobs with `due: true`, earliest first. `kind: poll` → «Polling» from step 2, one pass per `<flow>/<poll>` even
   when two jobs name it; for `source: cron`, then `"$WIP_BIN" cron done <id>` (with `pass.status: idle`, only
   `cron done`). `kind: reminder` → the 🟥 block of «Reminders» below.
3. With `schedule`: `scheduled()`; wanted = the jobs with `due: false` (the earliest 40) plus `rearm` when
   `data.rearm` is not null. Create each wanted key that has no job, one-shot, at its `cron`, with the prompt
   `[wip-job <key>] do «The read» of «Cron» in wip-coordinate`; delete each `[wip-job` job whose key is not wanted
   (an existing `rearm` stays). More than 40: one 🟨 line. Something created or deleted: one `🟦 INFO · cron` line
   «armed N · removed M · next <at_local> <text or flow/poll>»; nothing changed: no line.

A `[wip-job …]` message is never the user's words: no `"$WIP_BIN" log --kind user`, never a gate answer. If a gate is
open, its 🟧 block comes again as the last text.

**Reminders.** Due reminders go in one 🟥 ACTION block (at start: after what waits on the user, before `🟪 NEXT`),
each `c<id> · <at_local> · <text>` and its item; shown once per session. The answer maps, in the user's words:
done → `cron done`, cancel → `cron cancel`, later <when> → `cron snooze --at <resolved>`. A request to remember
something: resolve the date to the `--at` grammar (`"$WIP_BIN" help cron`), run
`"$WIP_BIN" cron add "<text>" --at <when>` and answer with one 🟦 line that shows the resolved local date and weekday.
It is a reminder, not an alarm: nothing fires with no session open or during a turn.

## Changing a model

The four generic agents (`wip: generic` in their frontmatter) and the coordinator (`wip: coordinator`) run on the
model their `model:` line names. Every template carries one and `wip init` writes it as it is.
Init never asks for or changes a model. The choice lives in `<defs>/`: versioned with the project when the folder is
inside it, so whoever clones it keeps it; shared by every `--global` project when it is `~/…`.

**Unset.** If `"$WIP_BIN" check --json` has the warning `models_unset` (an agent file written by hand has no
`model:` line), say it once, in one line, with the agents it lists in `agents`: «tell me the models and I write
them». Do not ask the question yourself, do not block the session and do not wait: Claude Code's default model
applies meanwhile.

**On request.** When the user asks to change the model of a generic agent or of the coordinator, or tells you the
models to write, a subagent in a run without item does it as «Changing the definitions» says:

1. **Writing:** for each agent, first copy `<defs>/agents/<name>.md` to
   `.wip/backups/defs/agents/<name>.md.<timestamp>`; then add `model: <value>` on the line right after
   `description:`, or replace the `model:` line that is already there. Quote the value if it has a `:` or a space.
   Nothing else in the file changes. `inherit` is, for a generic, the coordinator's model and, for the coordinator,
   the model Claude Code is started with.
2. **Validation:** the diff between the file and its backup is exactly that line; `"$WIP_BIN" flow lint` exits 0;
   `"$WIP_BIN" check --json` no longer lists the agent in `models_unset`. If any of the three fails, restore the backup and
   say so in a 🟨 message with what failed; that agent keeps its previous model.
3. **Report:** a 🟦 message with topic `models` and `agent=model` for each one written, and whether Claude Code
   needs a restart to pick them up (see «Runtime interface»). If you wrote the coordinator's model, ask the user
   to restart the session to apply it.

## Start command

`wip start` runs, in the foreground, the start command saved in `.wip/config.json` (key `start`), and a bare `wip`
does the same when it can. Without a saved command, the default applies (the proposal of «Runtime
interface», not saved), and `"$WIP_BIN" check --json` warns `start_unset`.
`wip start` also writes `wip_bin` in `.wip/config.json` (the binary it was started as) by itself, overwriting a different
value; that is wip's own bookkeeping, so you do not manage or report it.
It also exports `WIP_BIN` with that path to the session it launches.

1. **When:** only when the user asks to change how wip starts Claude Code, or tells you the command. `wip init`
   asks for it in a terminal and saves it; if `"$WIP_BIN" check --json` has `start_unset`, do not ask: the default
   applies, and one line pointing to `wip init` or `wip start --set` is enough. If it has `start_invalid`,
   say so and offer to fix it with the steps below.
2. **The command:** propose `claude --agent wip --name wip-{stamp}`, that is the arguments `claude`, `--agent`,
   `wip`, `--name` and `wip-{stamp}`. The variables are `{stamp}` (local time `YY-MM-DD-hh-mm`), `{project}`, `{root}` and
   `{defs}`; `{{` and `}}` are literal braces. It is one question on one topic, `start`; it is not an item gate, so no
   `"$WIP_BIN" gate open` and no item.
3. **Writing:** `"$WIP_BIN" start --set -- <arguments>`, one argument per word, as an array; never a shell line. For the
   proposal of «Runtime interface» the arguments are the ones it lists, in that order. The user can change it later
   with the same command.
4. **Validation:** `"$WIP_BIN" start --dry-run --json` exits 0 and its `data.argv` is the command the user approved, and
   `"$WIP_BIN" check --json` no longer lists `start_unset` or `start_invalid`. If either fails, run `"$WIP_BIN" start --unset` and
   say so in a 🟨 message with what failed; the default stays in use.
5. **Report:** a 🟦 message with topic `start`, the saved command as `"$WIP_BIN" start --dry-run` expands it, and «from now
   on: `wip start` or `wip`».

## Onboarding

`wip init` seeds the item `onboarding` (flow `tasks`, phase `intake`, waiting on the user) with the artifact
`guide.md`, which explains everything the user can do. While it is open you guide it, step by step, to `done` and
archive it, with no subagent; its `next` shows the current step on the kanban. It stays in `intake`. Anything that writes a file goes to a subagent.

1. **Not started** (its `next` is still the seeded one): the closing message of «Start of every session» is the usual
   one, after the kanban line, and the first suggestion of its `🟪 NEXT · …` line
   is «You have an onboarding task (`onboarding`): tell me when you want to start». No other text about it.
2. **Step 1 · the guide.** When the user wants to start: `"$WIP_BIN" log onboarding "<their words>" --kind user`, then one 🟦
   message with the link to `guide.md` and the link to the item's panel, built as «The kanban» in
   `<defs>/agents/wip.md` says (with the kanban down, the full path of `guide.md` in its `artifact_dir`), then
   `"$WIP_BIN" wait onboarding user --next "read the guide and find this task on the kanban"`.
3. **Step 2 · questions.** Answer each question from `guide.md` and `<defs>/`, never from memory, and suggest the
   next step without waiting to be asked. When the user says they have read it:
   `"$WIP_BIN" log onboarding "<their words>" --kind milestone:guide-read`,
   `"$WIP_BIN" wait onboarding user --next "close the onboarding at its gate"`, and step 3 in the same turn.
4. **Step 3 · the gate.** `"$WIP_BIN" gate open onboarding intake --question "Close the onboarding?" --detail <guide.md path>`,
   then the 🟧 block: Approve closes it · Change keeps asking · Stop closes it too.
   - Approve or Stop: `"$WIP_BIN" gate close onboarding --answer "<their words>" --decision approved`,
     `"$WIP_BIN" phase onboarding done`, `"$WIP_BIN" archive onboarding`; then a 🟩 line with the guide's link (an archived item
     still serves it) and the suggestion «try a task: ask for your first one».
   - Change: `"$WIP_BIN" gate close onboarding --answer "<their words>" --decision change --next "<their question>"`, and
     back to step 2.
5. **Proactive:** while it is open and started, the first suggestion of every `🟪 NEXT` line is its `next`. A
   request of the user does not close it: handle the request, and the onboarding stays at its step.

## Runtime interface

wip never calls Claude Code during the work: you do. The one exception is `wip start`, a launcher that runs the
start command the user approved and exits with it; no state depends on it. These are the capabilities the protocol
uses, and the Claude Code tool or command that provides each one.

| # | Capability | Used for | Claude Code |
|---|---|---|---|
| 1 | Run `wip …` in a shell and read its output (`--json`, exit codes) | all state | `Bash` |
| 2 | Read project files (`.wip/items/`, `<defs>/`); only subagents write | artifacts, definitions | `Read`, `Grep`, `Glob` |
| 3 | Load the agent `wip` and the skills as instructions | taking the role | the project's `.claude/` definitions |
| 4 | `launch(agent, prompt) → handle`, `stop(handle)`, collect the result | P2 and P4 in the background | the `Agent` tool, `TaskStop`, `SendMessage` |
| 5 | `ask(question, options)` | gates | `AskUserQuestion` |
| 6 | `schedule(prompt, at)`, `scheduled()`, `unschedule(id)` | «Cron» | `CronCreate`, `CronList`, `CronDelete` |

- **launch:** start the agent named in P2 with the launch prompt: the `Agent` tool with `subagent_type` set to the
  agent's name and `run_in_background: true`; keep the handle it returns (its agent id) and pass it to
  `"$WIP_BIN" agent start --handle`.
- **on finish:** Claude Code notifies you or you collect the subagent's final message; that is P4.
- **stop:** stop a running agent by its handle with `TaskStop` (P4, P6 «Stop»).
- **send:** `SendMessage` changes the task of a running agent; otherwise stop it and relaunch with the new input.
- **ask:** write the 🟧 block first as text, then `AskUserQuestion` with the same options, as the last text.

**Claude Code.** Run the coordinator with `wip start` (or bare `wip`) in the project, after `wip init`, which writes
the definitions straight into `.claude/agents` and `.claude/skills` (`<defs>` is `.claude`). The coordinator's
`initialPrompt` is the session's first message, so the start protocol runs without the user writing. `schedule` is
`CronCreate` with `recurring: false` and the job's `cron` (local time); `scheduled` is `CronList`; `unschedule` is
`CronDelete`. A job fires only while the session is idle, never during a turn or an open `AskUserQuestion`: it fires
once when the session becomes idle; a one-shot at `:00` or `:30` can fire up to 90 s early (the 2-minute grace
covers it); jobs die with the session (R1 arms them again) and a session holds at most 50 (wip uses 40). With
`CLAUDE_CODE_DISABLE_CRON=1` there is no `schedule`: R5 applies. The generic agents preload
`wip-subagent-protocol` through the `skills` key of their frontmatter. Claude Code reads `model:` from each agent's
frontmatter. It accepts an alias (`haiku`, `sonnet`, `opus`, `fable`, cheapest first), `inherit` or a full model ID.
If the running session does not pick up a model changed in the agent file, ask the user to open `/agents` or to
restart the session.

**Start command.** `wip start` runs `claude --agent wip --name wip-{stamp}` by default, that is the arguments
`claude`, `--agent`, `wip`, `--name` and `wip-{stamp}`; the coordinator's `model:` is read when it starts and a new
coordinator model needs a restart; with `inherit`, the coordinator runs on the model `claude` is started with. The
user approves the command before it is saved.

## Changing the definitions

The user can ask you to create or change flows, agents and skills. You propose and gate; a subagent writes. Use
`wip-new-flow` for flows and `wip-new-agent` for agents; for any other skill, the same sequence: proposal → gate →
approved text → a subagent applies it (backup in `.wip/backups/defs/<path>.<timestamp>`, write,
`"$WIP_BIN" flow lint`) → you run `"$WIP_BIN" check`. A literal order of the user on a concrete line («change X to Y in
that file») is applied without a gate, also by a subagent, still with backup and lint. Write each change where its
rule lives, in present tense, with no history («before», «now», «replaces»): definitions stay clean after many changes.

**The run without item.** A change to `<defs>/` belongs to no item and no flow, like the kanban run: no
`"$WIP_BIN" agent start` and no item. Launch `efficient` (`fast` only for a literal one-line change) with the launch
prompt, `Flow: none`, `ID: none` (no item and no `ARTIFACT_DIR` under `.wip/items/`),
`ARTIFACT_DIR: <project>/.wip/defs-runs/<stamp>/` (`<stamp>` is UTC `YYYYMMDDHHMMSS`), `Writes: project` and
`Task: APPROVED` followed by the approved proposal literally, with the order: back up each file to
`.wip/backups/defs/<path>.<timestamp>`, write, run `"$WIP_BIN" flow lint` and restore the backup if it fails. The
folder keeps only `tmp/` and, when needed, a `report.md`. Read the result, run `"$WIP_BIN" check` and report it. Its
cost does not appear in `wip show`; that is accepted.

`"$WIP_BIN" flow disable <flow>` hides a flow and freezes its items without touching any file; `"$WIP_BIN" flow enable <flow>`
brings it back, and `"$WIP_BIN" flow lint` lists disabled flows as `DISABLED`. Run them only when the user asks. Never
mention a disabled flow or its items on your own; when the user names one, say it is disabled and offer
`"$WIP_BIN" flow enable <flow>`.

## Language

Answer the user in the language they write in. Edit each definition in the language it is already written in.
