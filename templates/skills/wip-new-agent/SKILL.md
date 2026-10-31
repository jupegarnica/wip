---
name: wip-new-agent
description: "Create a project-specific subagent in the definitions folder's agents/ or change an existing one: frontmatter, body, proposed model, backup, registration in a flow and wip flow lint. Always proposal → APPROVED. Use when the user asks for a new agent or a specialised one for a phase."
wip: skill
---

# Creating or changing an agent

An agent is one file, `<defs>/agents/<name>.md` (`<defs>` is the definitions folder: `defs_dir` in
`.wip/config.json`, `.agents` when there is none): a YAML frontmatter and a Markdown body with its instructions.
Most phases need no new agent: the generic `fast`, `efficient`, `thinker` and `wise` cover any task by level. Create
one when a phase needs knowledge or a procedure that the generic agents would have to rediscover every time.

## Reserved names

`wip` (the coordinator), `fast`, `efficient`, `thinker` and `wise` belong to wip. Never create an agent with one of these
names; to change how a generic agent behaves, the user edits its file on purpose (it keeps `wip: generic`).

## Steps

1. **Understand the request.** What the agent does, in which phase of which flow, what it reads, what it writes
   and how it checks its work.
2. **Propose** (gate, per `wip-coordinate`, always; this skill never skips the gate): the full file (frontmatter and
   body), the flow and phase where it becomes `agent:` and the line it adds to that flow's `## Subagents`, and the
   **model** for its `model:` key (below). Options: Approve · Change · Stop.
3. With `APPROVED`:
   1. **Back up** each existing file you change: `.wip/backups/defs/agents/<name>.md.<timestamp>` and
      `.wip/backups/defs/skills/wip-flow-<flow>/SKILL.md.<timestamp>` (timestamp `YYYYMMDDHHMMSS`, UTC).
   2. **Write** the agent file exactly as approved. It always carries the subagent protocol: the `skills` key with
      `wip-subagent-protocol` and step 1 of «Before you start» as in the template. A proposal without them is
      incomplete: add them before the gate.
   3. **Register** it: `agent: <name>` on the phase and its line in `## Subagents` of the flow, if the proposal says so.
   4. **Lint:** `wip flow lint`. Exit 1 → restore the backups (or delete the new file), tell the user what failed.
   5. `wip check`.

## Template

```markdown
---
name: <name, equal to the file name>
description: "<one line: what it does and when the coordinator should launch it>"
role: subagent
capabilities: [read, write, shell]
model: <the model proposed in step 2>
skills:
  - wip-subagent-protocol
---

You are **<name>**, a subagent of this project. The coordinator launches you for <phase> of <flow> with a prompt;
you do that task, write your artifacts and return the output contract. You never talk to the user.

## Before you start

1. Read the skill `wip-subagent-protocol` and follow it: the prompt's `Protocol:` gives the full path of its
   `SKILL.md`. If the runtime already loaded it with this agent (the `skills` key above), you do not read it again.
2. Read the prompt fields (`Flow`, `ID`, `ARTIFACT_DIR`, `Phase`, `Writes`, `Inputs`, `Task`) and the files in
   `Inputs`.

## Task

<what it does, step by step; what it reads; how it checks its result>

## What you write

Only what `Writes:` allows. Your artifact: `ARTIFACT_DIR/<artifact name>`, in present tense.

## Output contract

The block of `wip-subagent-protocol`: `STATUS`, `ARTIFACTS`, `SUMMARY`, `QUESTIONS`.
```

Frontmatter keys:

| Key | Required | Value |
|---|---|---|
| `name` | yes | equal to the file name without `.md`; lowercase, digits and `-` |
| `description` | yes | one line; the coordinator chooses agents by it |
| `role` | yes | `subagent` (only the coordinator, `wip`, is `coordinator`) |
| `capabilities` | yes | what it needs from the runtime: `read`, `write`, `shell`; a subagent never has `spawn` or `ask-user` |
| `model` | no | read by the runtime, not by wip; proposed in step 2 |
| `skills` | yes | `[wip-subagent-protocol]` at least: a runtime that preloads an agent's skills gives it its contract at startup; the others ignore it |

A project agent never carries `wip: generic` or `wip: coordinator`: those marks are only for wip's own agents. Other
runtime keys are tolerated and not validated.

**The model.** Propose a value the runtime understands, chosen by the agent's level: as cheap as the task allows,
the same scale as `fast` → `wise`. Offer `inherit` (the coordinator's model) and the models the runtime lists when you
know them; otherwise ask for the value in free text. A runtime that does not read `model:` ignores it and runs the
agent with its default model: say so in the proposal.

**What it may write** is not a property of the agent: the phase's `writes:` decides it, and the coordinator passes
it in `Writes:`. Write the body so it works with either value.
