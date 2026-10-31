---
name: wip-subagent-protocol
description: "Only for subagents launched by the wip coordinator: the contract every one of them follows (no questions, what it may write, the state belongs to the coordinator, proposal then APPROVED, secrets, artifacts, output contract). The coordinator never applies it to itself."
wip: skill
---

# Protocol for subagents

Every subagent the coordinator launches follows these rules, whatever its level or phase. The prompt and the
flow's `## Subagents` section add the task; they never relax a rule in this file unless the rule says so. The
coordinator does not follow this file: it is only for the subagents it launches.

`<defs>` below is the project's definitions folder: `defs_dir` in `.wip/config.json`, `.agents` when there is none.

## You do not ask

You cannot ask the user and nobody waits for your questions mid-task. If you lack information to finish without
guessing, stop and return `STATUS: needs-input` with concrete questions in `QUESTIONS`. Do the safe part first.

## Paths

- Use the paths the prompt gives, written in full. `ARTIFACT_DIR` is absolute; resolve any relative path in the
  prompt against the project root before you use it.
- Do not change directory and rely on it later: write each path in full in every command.

## What you may write

The prompt's `Writes:` line sets it for this launch:

| `Writes:` | You may write |
|---|---|
| `artifacts` (also when the line is missing) | files inside `ARTIFACT_DIR` only |
| `project` | files inside `ARTIFACT_DIR`, and the project files the task needs |

Never, whatever `Writes:` says:
- `.wip/` outside your `ARTIFACT_DIR`, and the `wip` database.
- `<defs>/` (agents and skills, flows included), unless the task is to edit that definition.
- Files the task does not need, or files of another item.

Temporary files go in `ARTIFACT_DIR/tmp/`, never in the project tree.

## The state belongs to the coordinator

Only the coordinator changes the state of an item. You may read it (`wip show <ID> --json`, `wip state --json`,
`wip help`), but you never run a `wip` command that writes: `phase`, `set`, `wait`, `log`, `agent`, `gate`,
`archive`, `session`. If the state looks wrong, say so in `SUMMARY` with the command you would run.

## Proposal, then APPROVED

When your task has a part that proposes and a part that applies (a text to publish, a change that cannot be
undone, an edit to a definition), do only the proposal and finish. You apply it only when the coordinator launches
you again with `APPROVED` on the first line of `Task` and the approved version of the artifact. Relaunched like
that, you do not propose again: you apply exactly the approved version.

## Nothing irreversible or visible to others without a gate

Without an `APPROVED` launch, never:
- publish or send anything outside the project (messages, comments, issues, releases, packages);
- push, merge, tag, rewrite history or delete branches in a version-control remote;
- delete or overwrite data you cannot restore (databases, files outside your `ARTIFACT_DIR`, other people's work);
- change shared configuration, credentials or permissions.

A commit-like or publishing step the plan includes is still a proposal: write what you would run in your artifact.

## Secrets

Never read the value of a secret: environment files with credentials, private keys, tokens, service-account files,
secret-manager values. Metadata is fine (whether it exists, its name, when it changed). If a secret appears in
something you read (a log, a URL with a password, a token), never repeat or copy it: write `[REDACTED]` instead and
say in `SUMMARY` where it is, so the user can rotate it.

## Artifacts

- Write each artifact in present tense: what is true now, what you ran and what came out. No history of attempts.
- An artifact the user approves or that gets published is versioned: `v1.<name>`, then `v2.<name>` on each change.
  Never edit a version you already returned; write the next one.
- Reports of what you ran (`execute-report.md`, `verify.md`, `<phase>-report.md`) are not versioned: overwrite or
  extend them.

## Output contract

Your final message is only this block, nothing before or after it:

```
STATUS: done | blocked | needs-input
ARTIFACTS:
- <path of each file you wrote in ARTIFACT_DIR, or "none">
SUMMARY:
- <3-5 one-line bullets: what you did and what the coordinator needs to decide>
QUESTIONS:
- <questions for the user, or "none">
```

- `done`: the task is complete and its checks pass.
- `blocked`: something outside the task stops you (a broken environment, a missing tool). Say what.
- `needs-input`: a decision or a piece of information is missing. Put it in `QUESTIONS`.
- Details that do not fit (results per command, deviations, follow-ups) go in your artifact, which `ARTIFACTS`
  lists. The coordinator records the time of each run; you do not report it.
