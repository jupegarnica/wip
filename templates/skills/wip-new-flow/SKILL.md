---
name: wip-new-flow
description: "Create a new wip flow (the skill wip-flow-<name>) or change an existing one: proposal, gate, backup, write, wip flow lint, restore on failure, wip check, and what happens to live items. Use when the user asks for a new flow, a new phase, or a change in how a flow moves."
wip: skill
---

# Creating or changing a flow

A flow is one skill, `<defs>/skills/wip-flow-<flow>/SKILL.md` (`<defs>` is the definitions folder: `defs_dir` in
`.wip/config.json`, `.agents` when there is none). The folder's suffix is the flow's name. The file holds a
frontmatter (`name: wip-flow-<flow>` and a `description` that says which items the flow is for), a title, a short
description, one `wip-flow` block (the only source of phases), a `## Subagents` section and one `### <phase>`
section per phase. The CLI discovers a new folder on the next command; a file that does not pass lint is never used
(the CLI keeps using the last valid version and warns).

`example.md`, next to this file, is a complete flow to copy from. It is a reference, not a flow: the CLI only
discovers folders named `wip-flow-*`.

## Steps

1. **Understand the request.** What the items of this flow are, how each one starts and ends, which phases need a
   user decision and which subagent does each phase. For a change: `wip state --flow <flow>` lists the live items
   it affects.
2. **Propose** (gate, per `wip-coordinate`): the phases in order with their `gate`, `next` (and `from_any`), `agent` and `writes`; the
   `fields`; and, for a change, what happens to each live item in a phase that changes or disappears. Options:
   Approve · Change · Stop. A literal order of the user on one line of an existing flow skips the gate (steps 3-6
   still apply).
3. **Back up** an existing file before writing: copy it to
   `.wip/backups/defs/skills/wip-flow-<flow>/SKILL.md.<timestamp>` (timestamp `YYYYMMDDHHMMSS`, UTC).
4. **Write** the file. For a new flow, start from a copy of `example.md` (next to this skill) or of
   `<defs>/skills/wip-flow-tasks/SKILL.md`, set `name: wip-flow-<flow>` and its `description`, drop the `wip:` line
   (that mark is only for the files `wip init` writes), and change what the proposal says. Present tense, no history: the file describes the flow as it is, never what it replaced.
5. **Lint:** `wip flow lint <flow>` (exit 3: the flow is disabled; enable it first or skip the lint). Exit 1 → restore the backup (or delete the new file), tell the user what failed,
   and go back to step 2 or fix the obvious mistake and lint again.
6. **Check:** `wip check`. The next command on an item of this flow already uses the new version.
7. **Live items** in a phase that no longer exists: lint reports them and the flow is not activated. With the user's
   decision recorded (`wip log <ID> "<their words>" --kind user`), move each one first with
   `wip phase <ID> <phase> --force --reason "<why>"`, then write the flow again.

`<defs>/` is versioned with the project: the user reviews the change as any other diff.

## The block

```wip-flow
version: 1
id_pattern: "[a-z][a-z0-9-]{1,30}"
fields:
  title: string
links:
  - pattern: "^T([0-9]+)$"
    url: "https://tracker.example.com/t/$1"
phases:
  - name: intake
    gate: none
    next: [plan]
    waiting_default: user
  - name: plan
    gate: ask
    next: [execute]
    agent: thinker
    writes: artifacts
  - name: execute
    gate: auto
    next: [done]
    agent: efficient
    writes: project
  - name: done
    kind: terminal
```

Top-level keys (any other key is an error):

| Key | Required | Value |
|---|---|---|
| `version` | no | `1` |
| `color` | no | `"#RRGGBB"` (quoted: an unquoted `#` starts a YAML comment): the tone of this flow's stage colours on the board; blue when absent |
| `id_pattern` | no | a regular expression the whole item ID must match; the safe default (letters, digits, `.`, `_`, `-`, up to 64) always applies too |
| `fields` | no | `name: type`; types `string`, `int`, `list`, `ts`, `enum(a\|b\|c)`; lowercase names; `title` always exists |
| `links` | no | list of `{pattern, url}`: a regular expression over the item ID and an `http(s)` URL with `$1`… |
| `phases` | yes | the list below, in order; the first phase is where items start |
| `seed` | no | list of `{id, phase, title, next, files}` that `wip init` creates once, in a phase whose `waiting_default` is `user` or `external`; an ID that already exists, even archived, is never touched. `files` lists files of this flow's skill folder (artifact names, no subfolders) that init copies into the new item's artifact directory |
| `polling` | no | list of `{name, phases, agent, cadence}`: which agent checks which phases and how often (see below) |

Polling: wip never runs anything by itself. `polling` only declares scheduled checks that a scheduler (the coordinator,
cron, CI) asks about with `wip poll due`:

```yaml
polling:
  - name: waiting        # lowercase, unique in the flow
    phases: [waiting]    # optional: the phases whose open items it checks; none = a flow-wide pass (discovery)
    agent: fast          # required: <defs>/agents/<agent>.md must exist, like a phase's agent
    cadence: 1h          # required: a whole number and m, h or d (30m, 1h, 2d)
```

A poll with `phases` applies while an item sits in one of them; a poll without them always applies. Add one to a
phase that waits on something outside the session (`kind: wait`); the pass finds out, and the coordinator moves the item.

Phase keys:

| Key | Default | Value |
|---|---|---|
| `name` | — | lowercase, unique; it names folders |
| `kind` | `work` | `work`, `wait` (someone outside the session) or `terminal` (exactly one) |
| `gate` | `none` | `ask` (the user approves the result), `auto` (moves on when `done`), `none` |
| `next` | — | phases it may move to; required except in the terminal phase, never itself |
| `from_any` | `false` | `true` makes the phase reachable from any non-terminal phase with a plain `wip phase`, no `--force`: for a hub such as `plan`, or a terminal reachable from anywhere. A phase listed in a `next` too is fine; the terminal phase is never left through it |
| `waiting_default` | `agent` | who it waits on when it starts: `agent`, `user`, `external`, `none` (terminal only) |
| `stage` | — | optional column for the web board; when every phase has one, equal stages must be contiguous. The board paints each stage in one tone, more transparent stage after stage; a phase without a stage has no colour |
| `agent` | — | the default agent of the phase; its file `<defs>/agents/<agent>.md` must exist with `name` and `description` |
| `writes` | `artifacts` | what its subagent may write: `artifacts` (only its `ARTIFACT_DIR`) or `project` (also project files) |

Other phase keys are tolerated and not validated. Every phase must be reachable from the first through `next` or `from_any`.

**Choosing `agent:`.** The generic agents are the default options, from cheapest to most capable: `fast` (mechanical,
fully specified), `efficient` (a clear plan or written criteria), `thinker` (decisions, plans, investigation),
`wise` (high ambiguity or risk; never a template default). A project-specific agent made with `wip-new-agent` can be
named as well. **Choosing `writes:`.** `project` only for the phases that are meant to change the project; plans,
reviews and verifications stay `artifacts`.

## The text around the block

- The frontmatter: `name: wip-flow-<flow>` (equal to the folder) and a one-line `description` that says which items
  the flow is for and that the coordinator reads it before every phase. `wip flow lint` rejects a file without them.
- A title and two or three lines on what an item of this flow is and how it ends.
- `## Subagents`: which agent each phase uses and when the coordinator should choose another one; extra prompt
  fields the subagents need.
- `### <phase>` for each phase: inputs, the artifact it produces, what the gate shows, where it goes next. The
  coordinator reads it before every phase.
- No table of phases: the block is the only source, and a second copy drifts.
