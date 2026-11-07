---
name: wip-new-agent
description: "Create a project-specific subagent in the definitions folder's agents/ or change an existing one: frontmatter, body, proposed model, backup, registration in a flow and \"$WIP_BIN\" flow lint. Always proposal → APPROVED. Use when the user asks for a new agent or a specialised one for a phase."
wip: skill
---

# Creating or changing an agent

An agent is one file, `<defs>/agents/<name>.md` (`<defs>` is the definitions folder: `defs_dir` in
`.wip/config.json`, `.claude` when there is none; a `defs_dir` that starts with `~/` is in the user's home folder
(`wip init --global`), shared by every project initialised that way): a YAML frontmatter and a Markdown body with its instructions.
Most phases need no new agent: the generic `fast`, `efficient`, `thinker` and `wise` cover any task by level. Create
one when a phase needs knowledge or a procedure that the generic agents would have to rediscover every time.

## Reserved names

`wip` (the coordinator), `fast`, `efficient`, `thinker` and `wise` belong to wip. Never create an agent with one of these
names; to change how a generic agent behaves, the user edits its file on purpose (it keeps `wip: generic`).

## Steps

1. **Understand the request.** What the agent does, in which phase of which flow, what it reads, what it writes
   and how it checks its work.
2. **Propose** (gate, per `wip-coordinate`, always; this skill never skips the gate), in two parts:
   1. **Ask each key.** Before the proposal, the coordinator asks the user the value of every frontmatter key of the
      «Frontmatter keys» table below, except `wip` (a project agent never carries it). It asks in groups, one question
      per group, and offers each key's default from the table. The keys that can stay at default are all except `name`,
      `description` and `skills`; `tools` and `model` are the keys worth a real answer. The coordinator never picks a
      value for a key silently: a key the user leaves at default is not written (Claude Code's default applies), as the table says.
   2. **Proposal.** The full file (frontmatter with the keys that carry a value, and body), the flow and phase where it becomes
      `agent:` and the line it adds to that flow's `## Subagents`, and the **model** for its `model:` key (below).
      Options: Approve · Change · Stop.
3. With `APPROVED`, a subagent applies the approved text in a run without item (`wip-coordinate`, «Changing the
   definitions»): the coordinator launches `efficient` with `APPROVED` and the approved proposal literally in `Task:`,
   and the subagent does:
   1. **Back up** each existing file it changes: `.wip/backups/defs/agents/<name>.md.<timestamp>` and
      `.wip/backups/defs/skills/wip-flow-<flow>/SKILL.md.<timestamp>` (timestamp `YYYYMMDDHHMMSS`, UTC).
   2. **Write** the agent file exactly as approved. It always carries the subagent protocol: the `skills` key with
      `wip-subagent-protocol` and step 1 of «Before you start» as in the template. A proposal without them is
      incomplete: add them before the gate.
   3. **Register** it: `agent: <name>` on the phase and its line in `## Subagents` of the flow, if the proposal says so.
   4. **Lint:** `"$WIP_BIN" flow lint`. Exit 1 → restore the backups (or delete the new file) and report what failed.
   5. The coordinator reads the report, runs `"$WIP_BIN" check` and tells the user the result.

## Template

```markdown
---
name: <name, equal to the file name>
description: "<one line: what it does and when the coordinator should launch it>"
tools: <comma-separated tools it may use; omit the line to inherit all>
model: <the model proposed in step 2; omit the line when there is none>
skills:
  - wip-subagent-protocol
---

You are **<name>**, a subagent of this project. The coordinator launches you for <phase> of <flow> with a prompt;
you do that task, write your artifacts and return the output contract. You never talk to the user.

## Before you start

1. Read the skill `wip-subagent-protocol` and follow it: the prompt's `Protocol:` gives the full path of its
   `SKILL.md`. If Claude Code already loaded it with this agent (the `skills` key above), you do not read it again.
2. Read the prompt fields (`Flow`, `ID`, `ARTIFACT_DIR`, `Phase`, `Writes`, `Inputs`, `Task`) and the files in
   `Inputs`.

## Task

<what it does, step by step; what it reads; how it checks its result>

## What you write

Only what `Writes:` allows. Your artifact: `ARTIFACT_DIR/<artifact name>`, in present tense.

## Output contract

The block of `wip-subagent-protocol`: `STATUS`, `ARTIFACTS`, `SUMMARY`, `QUESTIONS`.
```

## Frontmatter keys

The 19 keys are the official subagent keys of Claude Code, in the order of its documentation. Only a key with a value
is written, in this order: a key without a value is not written (omit it; Claude Code's default applies), because
Claude Code does not take an empty key as unset. Never write `key:`, `[]` or `{}`. The default column says what an omitted
key means at runtime, as Claude Code documents it.

| Key | Required | Value | Default / when unset |
|---|---|---|---|
| `name` | yes | equal to the file name without `.md`; lowercase, digits and `-` | none |
| `description` | yes | one line; the coordinator chooses agents by it | none |
| `tools` | no | comma-separated tools it may use; never the tool that spawns agents, the question tool or the notebook tool (a subagent does not spawn, does not ask, does not edit notebooks); MCP tools are not listed | omitted: inherits all the tools |
| `disallowedTools` | no | tools removed from the inherited or listed set | omitted: none removed |
| `model` | no | read by Claude Code, not by wip; proposed in step 2 | omitted: the subagent model order (wip adds the `model:` line after `description:` at init) |
| `permissionMode` | no | the permission mode of the subagent; an explicit value overrides the session's mode | omitted: inherits the session's mode |
| `maxTurns` | no | maximum number of turns | omitted: no limit |
| `autoCompactWindow` | no | context size that triggers automatic compaction (100000 to 1000000) | omitted: not set |
| `skills` | yes | `[wip-subagent-protocol]` at least: Claude Code preloads an agent's skills and gives it its contract at startup | none |
| `mcpServers` | no | MCP servers the subagent gets | omitted: none |
| `hooks` | no | hooks of the subagent | omitted: none |
| `memory` | no | persistent memory scope: `user`, `project` or `local` | omitted: off |
| `background` | no | run the subagent in the background | omitted: not set (spawned subagents already run in background) |
| `omitClaudeMd` | no | skip the project's instructions file | omitted: loads the project's instructions file |
| `effort` | no | reasoning effort of the subagent | omitted: the session's level |
| `isolation` | no | `worktree` runs the subagent in a temporary git worktree | omitted: not set |
| `color` | no | colour of the subagent in the interface | omitted: not set |
| `initialPrompt` | no | first prompt of the subagent | omitted: not set |
| `experimental` | no | experimental settings, such as `cacheTtl` | omitted: none |

`wip` is not a key of the table: it marks wip's own agents (`wip: generic` or `wip: coordinator`), and a project agent
never carries it. Keys that Claude Code adds later and that are not in the table are tolerated and not validated.

**The model.** Propose a value Claude Code understands, chosen by the agent's level: as cheap as the task allows,
the same scale as `fast` → `wise`. Offer `inherit` (the coordinator's model) and the models Claude Code lists when you
know them; otherwise ask for the value in free text.

**The tools.** The user's answer for `tools` is the list the agent needs for its phase. A list without `Bash` cannot
run the checks of its phase; a list without `Edit` or `Write` cannot write its artifact. Say in the proposal which
tools the list leaves out, and that MCP tools are not in it.

**What it may write** is not a property of the agent: the phase's `writes:` decides it, and the coordinator passes
it in `Writes:`. Write the body so it works with either value.
