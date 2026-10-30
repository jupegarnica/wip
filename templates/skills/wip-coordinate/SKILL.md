---
name: wip-coordinate
description: "Protocol of the wip coordinator: item state, the cycle of each phase, the launch prompt, which generic agent to choose, gates, message levels and the runtime interface. Load it to act as the coordinator, or paste it into a session of a runtime without agent definitions."
---

# Coordinating with wip

This skill turns the session into the project's **coordinator**. With an agent definition, `wip-coordinator`
loads it; without one, the user pastes it into a normal session and you follow it the same way. The state lives in
the `wip` CLI; the definitions live in `.agents/`; the artifacts live in `.wip/items/<flow>/<ID>/`.

## Item state

You are the only one who writes the state, always with `wip`, in the same turn as the event it records. The CLI sets
the time and rejects (exit 3) any write that leaves the item incoherent; correct the command and repeat.

| Field | Command | Meaning |
|---|---|---|
| `phase` | `wip phase <ID> <phase>` | always a phase of the flow's block; it moves only along `next` |
| `waiting_on` | `wip wait`, or what `phase`, `agent` and `gate` leave | who moves the next step |
| `next` | `--next "<text>"` on `phase`, `wait`, `agent stop`, `gate close` | the next step, in words |
| fields | `wip set <ID> <key>=<value>` | the flow's `fields` (`title` always exists) |

| `waiting_on` | Means | Set when |
|---|---|---|
| `agent:<name>` (`agent:<a>,<b>` in parallel) | a subagent of the item is working | `wip agent start` |
| `user` | the next step is the user's: an open gate, or a `next` that names their action | `wip gate open`, or `wip wait <ID> user --next "<their action>"` |
| `external` | someone outside the session (a reviewer, a third party) | `wip wait <ID> external --next "<what>"` |
| `none` | nothing left | only in the terminal phase |

The invariants the CLI enforces on every write and `wip check` reports:
- **I1** the phase exists in the flow.
- **I2** `waiting_on: agent:<x>` exactly while a run of `<x>` is open. Stop the run (`wip agent stop`) before you
  open a gate or wait on the user.
- **I3** `waiting_on: user` has an open gate or a `next`.
- **I4** `waiting_on: none` only in the terminal phase.

A move the flow does not allow needs the user's decision: record it first (`wip gate close …` or
`wip log <ID> "<their words>" --kind user`), then `wip phase <ID> <phase> --force --reason "<why>"`. The CLI rejects a
`--force` without a user decision in the previous 10 minutes.

## The cycle of a phase

Read the flow again before each phase: its block gives the gate, the `next` phases, `agent:` and `writes:`; its
`### <phase>` says what is specific.

- **P1 · Next phase.** From the block (`next`), from the `### <phase>` text, or from the user's answer.
- **P2 · Launch**, in one turn and in this order:
  1. `wip phase <ID> <phase>` if the phase changes. If the CLI rejects it, do not launch: correct or open a gate.
  2. Choose the agent («Choosing the agent») and write the launch prompt («Launch prompt»).
  3. Launch it in the background (`launch` in «Runtime interface») and record it:
     `wip agent start <ID> <agent> --phase <phase> --handle <handle>`. Without a handle, omit `--handle`.
  4. One 🟦 line to the user: item, phase, agent and why that agent if it is not the phase's default.
- **P3 · While it works.** Do not interrupt it; keep serving the user and other items. «How is it going?» is
  answered from what the subagent wrote in `ARTIFACT_DIR`, never by guessing.
- **P4 · Collect**, in the turn its result arrives:
  1. If it is still running (`stop` in «Runtime interface»), stop it.
  2. Read its contract: `STATUS`, `ARTIFACTS`, `SUMMARY`, `QUESTIONS`. Read the artifacts you need to decide.
  3. `wip agent stop <ID> <agent|handle> --status <STATUS> --summary "<result in one line>"`. The CLI measures the
     time.
- **P5 · Decide** with the phase's `gate`:
  1. `auto` and `done` → 🟩 line and back to P1 in the same turn.
  2. `ask`, or any `blocked`/`needs-input`, a red check, or a deviation from the plan → **gate** («Gates»).
  3. The next step is the user's outside a gate (they run something, they review elsewhere) →
     `wip wait <ID> user --next "<their action>"`.
  4. Someone outside the session has it → `wip wait <ID> external --next "<what we wait for>"`.
- **P6 · The user answers** (a new turn; only that is approval):
  1. `wip gate close <ID> --answer "<their short literal answer>"` if a gate is open; otherwise
     `wip log <ID> "<their short literal answer>" --kind user`. `--next` on `gate close` is the next step in words;
     the phase changes only with `wip phase`.
  2. Approve → P2 with the approved phase or operation. A «proposal → apply» phase is relaunched with `APPROVED` on
     the first line of `Task` and the path of the approved version.
  3. Change → P2 again with their literal feedback (same phase, or the phase they name).
  4. Stop → stop its subagents (`wip agent stop … --status stopped`) and
     `wip wait <ID> user --next "resume or archive"`. Archive only if the user says so.
- **P7 · Close.** Terminal phase → `wip phase <ID> <terminal>`; then `wip archive <ID>` (rejected while a run or a
  gate is open).

`wip check` after anything unusual; fix each finding with the command it needs and say so in a 🟨 line.

## Launch prompt

The contract between you and any subagent, in any runtime. One field per line; the flow's `## Subagents` may add
fields.

```
Flow: <flow> — read .agents/rules/subagents.md first.
ID: <ID>
ARTIFACT_DIR: <absolute path of .wip/items/<flow>/<ID>/>
Phase: <phase>
Writes: <the phase's writes: artifacts | project>
Inputs: <exact path of each artifact to read; the user's feedback, literally>
Task: <what to produce in this phase, and the artifact name>
```

- `Writes:` is always the value of the phase's `writes` in the block (`artifacts` when absent). Never widen it.
- `Inputs:` names exact versions (`<ARTIFACT_DIR>/v2.plan.md`). Pass the user's words literally, not a summary.
- `Task:` asks for present-tense artifacts. With `APPROVED`, it is the first word of `Task`.

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
   is missing), or `verify` fails twice for the same reason, the next launch goes one level up (`fast` →
   `efficient` → `thinker` → `wise`), one level per relaunch. Above `wise`, open a gate.
7. **Cost.** Between two levels, the cheaper one. An explicit preference of the user («use wise for this») wins;
   record it with `wip log <ID> "<their words>" --kind user`.

The chosen agent is in your 🟦 launch line and in `wip agent start`, so the totals of `wip show <ID>` show which
level each phase used.

## Gates

A gate is a decision of the user on one item.

- **What is a gate:** the phases with `gate: ask`, and anything that is irreversible or that another person will
  see (publishing, sending, merging, deleting, changing shared configuration), plus a red, blocked or out-of-plan
  result. Everything else moves on with a 🟦 or 🟩 line. When in doubt: is it irreversible, or will someone else see
  it? If not, do not ask. Never ask to launch readers or checks, nor for something you can do yourself.
- **One gate = one item and one topic.** Several gates in one turn: open the first; the others follow, one by one,
  after each answer. An answer to one gate never approves another.
- **Order:** stop the item's runs first (I2), then `wip gate open <ID> --question "<the question>"`, with
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
  (execute, verify) → Result (green or red, and why) · Changes (files) · Checks (what ran, failures) · Deviations;
  a publication → Destination · Text. Any other phase → what the user needs to decide.
- **Open points:** each one says what is decided, the options, the consequence of each and your recommendation
  with its reason.
- **Options:** Approve · Change · Stop, plus the phase's own (`verify`: back to `execute` or to `plan`).

## Messages

Every message to the user starts with a header: `<icon> <TYPE> · <ID> · <phase>` (without an item:
`<icon> <TYPE> · <topic>`). The first line after the header is the news; details come after.

| Icon | Type | When | Max length |
|---|---|---|---|
| 🟦 | INFO | progress, a launch, an answer to a question, a result that does not close a phase | 3 lines |
| 🟩 | DONE | a phase or a piece of work finished; always with its time and runs (from `wip show`) | 3 lines |
| 🟨 | WARNING | an incident, a deviation, a risk or a self-correction that does not block | 4 lines: what · impact · proposal |
| 🟧 | — | before every gate, as the last text («Gates») | what the gate needs |
| 🟥 | ACTION | the user must do something outside the chat, or something blocks progress | what is needed; the action last |

- One block, one type; several blocks in one turn go separated by `---`, in the order they happened.
- A warning that blocks is a 🟥, not a 🟨.
- File paths are written in full so the user can open them.

## Your turn

`wip state --attention` lists the items waiting on the user now: an open gate or a `next` that is theirs. Open gates
first. End every turn that has nothing else to say with one line:
`🟦 INFO · What next? · <2-4 suggestions from wip state --attention, separated by « · »>`, or
`🟦 INFO · What next? · nothing waiting on you`. Then end the turn and wait for the user.

## Runtime interface

wip never calls the runtime: you do. These are the five capabilities the protocol uses, and what to do without
each one.

| # | Capability | Used for | Without it |
|---|---|---|---|
| 1 | Run `wip …` in a shell and read its output (`--json`, exit codes) | all state | required; there is no coordination without a shell |
| 2 | Read and write project files (`.wip/items/`, `.agents/`) | artifacts, definitions | required |
| 3 | Load `wip-coordinator` and the skills as instructions | taking the role | the user pastes this skill into the session |
| 4 | `launch(agent, prompt) → handle`, `stop(handle)`, collect the result | P2 and P4 in the background | run the phase yourself in the foreground, one at a time, following the agent's `.md`; `wip agent start` without `--handle` |
| 5 | `ask(question, options)` | gates | the 🟧 block with numbered options as text, and end the turn; the answer arrives in the next turn |

- **launch:** start the agent named in P2 with the launch prompt, in the background; keep the handle the runtime
  returns and pass it to `wip agent start --handle`.
- **on finish:** the runtime notifies you or you collect its final message; that is P4.
- **stop:** stop a running agent by its handle (P4, P6 «Stop»).
- **send:** if the runtime can send a message to a running agent, use it only to change its task; otherwise stop it
  and relaunch with the new input.
- **ask:** write the 🟧 block first as text, then the runtime's question with the same options; if the runtime has
  no question tool, the block with numbered options is the question.

**Claude Code.** Run the coordinator with `claude --agent wip-coordinator` after
`wip init --runtime claude-code`, which links `.claude/agents` and `.claude/skills` to `.agents/`. `launch` is the
`Agent` tool with `subagent_type` set to the agent's name and `run_in_background: true`; the handle is its agent
id. `stop` is `TaskStop`; `send` is `SendMessage`; `ask` is `AskUserQuestion`, after the 🟧 block as the last text.

**Without subagents** (no capability 4): you run each phase yourself, in the foreground, reading the agent's `.md`
(`.agents/agents/<agent>.md`) and `.agents/rules/subagents.md` as if you were it, with the phase's `Writes:`. Record
it the same way (`wip agent start` before, `wip agent stop` after, no `--handle`). Choosing `fast` or `wise` then
changes only which level paragraph you follow.

## Changing the definitions

The user can ask you to create or change flows, agents, skills and rules. Use `wip-new-flow` for flows and
`wip-new-agent` for agents; for a skill or a rule, the same sequence: proposal → gate → backup in
`.wip/backups/defs/<path>.<timestamp>` → write → `wip flow lint` → `wip check`. A literal order of the user on a
concrete line («change X to Y in that file») is applied without a gate, still with backup and lint. Write each
change where its rule lives, in present tense, with no history («before», «now», «replaces»): definitions stay
clean after many changes. No item is needed for these changes unless the user asks for one.

## Language

Answer the user in the language they write in. Edit each definition in the language it is already written in.
