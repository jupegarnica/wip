# wip-kanban

A read-only Kanban of the project's open [wip](https://github.com/jupegarnica/wip) items, drawn in a pane of
Claude Code. Every row is `<id> <phase>`; its column follows the phase's place in the flow's declared order, and
its colour follows the same stage ramp the wip web paints. Clicking a row opens that item's panel in the wip web.

The mod never changes wip: it reads `wip state --json` once at the start and once every five seconds, one process
at a time, with a four-second timeout. A failed read keeps the last board on screen and shows the reason; a first
read that fails shows only the reason.

## Install

A third party installs wip as usual and runs `wip init` in the project. The wizard's fifth step asks:

- `Install the wip Kanban mod for Claude Code?` — `yes` (the default; Enter installs the copy and the entry) or
  `no`.
- After `yes`, `Where does the enabledPlugins entry go?` — `settings.json` (the default;
  `.claude/settings.json`, Claude's project scope, shared with the repository) or `settings.local.json`
  (`.claude/settings.local.json`, Claude's local scope, personal to this clone and normally not versioned; Claude
  applies it over the project file for the same plugin id).

Without a terminal, the flags decide:

```sh
wip init --yes --kanban
wip init --yes --kanban --kanban-settings-file settings.local.json
```

`--kanban` installs the copy and writes the entry; `--kanban-settings-file` chooses the file that receives it and
is only valid together with `--kanban`. `wip init --yes` alone installs nothing: the default `yes` is the wizard's,
and a script installs with `--kanban`. `--global` decides where the wip agents and skills live, never where the mod
lives.

The install is two things:

- a self-contained copy of this mod in `<project>/.claude/skills/wip-kanban/`, which Claude Code loads by itself as
  `wip-kanban@skills-dir` in a new session (no `--plugin-dir`, marketplace or download);
- `"enabledPlugins": {"wip-kanban@skills-dir": true}` merged into the settings file you chose, with every other
  key preserved and a backup in `.wip/backups/claude-settings/`.

The other settings file is never written: it is only read, to warn you when its entry wins
(`kanban_settings_overridden`, `kanban_settings_duplicate`) or cannot be read (`kanban_settings_unreadable`).

## Trust, reloading, and the first load

A copy in the project is still a project-scope plugin: Claude shows it suppressed until you trust the workspace,
also when the entry is in `.claude/settings.local.json`. Accept the trust dialog, then run `/reload-plugins` (or
start a new session). The pane opens on its own as `wip Kanban`: Claude Code places a pane no one asked for from
144 terminal columns, and one the person opened before from 110. On a narrower terminal the mod opens it on your
first prompt, and from then on it opens at launch in terminals of 110 columns or more. Below 110 columns the
engine places no pane, even with `/wip-kanban on`. A copy installed before this version needs `wip init --force`
to get this. `/wip-kanban on` and `/wip-kanban off` open and close it, and a pane closed by hand opens again on the
next session.

## Using it

- The flow filter is the dim row at the bottom right of the pane, outside the board: one button per flow,
  `✓ <flow>` shows it, `✗ <flow>` hides it, one space apart. Hiding removes the flow's items and keeps its
  button. The list of hidden flows is kept per project in the mod's store, keyed by the project's absolute root,
  so another project is unaffected. The board prints no flow names; the buttons are the only place they appear.
- A row is placed by the phase's ordinal: the first phase starts at the left edge, the last ends at the right
  edge, and a one-phase flow stays at the left. A label too long for the pane is cut with `…`.
- A row with `signals.attention` takes the stage's solid colour as its background with the contrasting text; any
  other row uses its flow's colour at full opacity (the phase's alpha is not applied), so a late phase stays
  legible. A phase without a stage keeps plain text, and one the flow does not declare is prefixed `! `.
- Clicking a row opens `webUrl` with `?item=<flow>/<id>`; the web shows that item's panel. The board works without
  the server, but the link needs `wip web` running at that URL (terminal link opening may need Cmd/Ctrl).

## Configuration

`claude plugin configure wip-kanban@skills-dir` (or the plugins menu) sets:

- `webUrl` — default `http://localhost:33333/`, the first port `wip web` tries. If the server uses another port,
  change it here. Only `http:` and `https:` URLs are accepted; an invalid one leaves the IDs as plain text.
- `colorScheme` — `dark` (default) or `light`: which theme's solid colours and contrasting text the attention rows
  use, and which amber fallback a stageless attention row takes. Non-attention rows use the flow tone in both
  schemes. The pane API does not expose the active theme, so this choice is explicit.

## Update, disable and remove

- Update after installing a new wip: run `wip init --force` (or `wip init --kanban --force`) in the project. With
  `--force` the whole folder is replaced: managed files go back to the embedded text, your own extra files are
  removed, and the previous folder is copied first to `.wip/backups/kanban/wip-kanban.<stamp>/`. The generated
  `.claude-plugin/types/` is kept. A second `--force` with nothing changed says `exists` and writes nothing.
- `--force` without `--kanban` refreshes the copy and touches neither settings file, so a plugin you disabled
  stays disabled. Only `--kanban` writes `true` (with a backup of the settings file).
- Disable without deleting, with the scope of the file that holds the entry:

  ```sh
  claude plugin disable wip-kanban@skills-dir --scope project
  claude plugin enable wip-kanban@skills-dir --scope project
  # or --scope local for .claude/settings.local.json
  ```

  Then `/reload-plugins` or restart. Using the wrong scope does nothing to the other file's entry.
- Remove: delete `.claude/skills/wip-kanban/` and, if you want, the `enabledPlugins` entry from the settings file
  that holds it (`claude plugin uninstall` is for marketplace installs, not `skills-dir` copies). `wip init --kanban`
  installs it again.

## Development

This folder is the source of the mod. From a checkout, run it without installing:

```sh
claude --plugin-dir /path/to/wip/mods/wip-kanban --debug
```

For the desktop app, set `CLAUDE_CODE_PLUGIN_DIRS` to the same folder before starting it. Do not run the
development folder and an installed `skills-dir` copy at once in one session: both register `/wip-kanban` and the
pane. In a session that already runs a copy, `/reload-plugins` picks up an edit.

Checks: `claude plugin validate mods/wip-kanban` and `claude plugin test mods/wip-kanban`.

## Licence

MIT. See `LICENSE`.
