# wip-kanban

A read-only Kanban of the project's open [wip](https://github.com/jupegarnica/wip) items, drawn in a pane of
Claude Code. Every row is `<id> <phase>`; its column follows the phase's place in the flow's declared order, and
its colour follows the same stage ramp the wip web paints. Clicking a row opens that item's panel in the wip web:
on the terminal through the server's LAN address when it has one, and in the Claude Desktop app and the VS Code
extension through its Local address, because those surfaces only draw a link they can open.

The mod never changes wip's items or state: it reads `wip state --json` once at the start and once every five
seconds, one process at a time, with a four-second timeout. A failed read keeps the last board on screen and shows
the reason; a first read that fails shows only the reason. To link a row, it also asks this project's server where
it listens with `wip web status --json`, at the start and then about every fifteen seconds, and keeps both answers:
its Local `url` (`http://localhost:<port>/`) and its LAN `lan_url` when it has one. That command may remove a stale
`.wip/web` entry, and nothing else in wip changes.

## Install

A third party installs wip as usual and runs `wip init` in the project. The wizard's fourth step asks:

- `Install the wip Kanban mod for Claude Code?` — `yes` (the default; Enter installs the copy and the entry) or
  `no`.
- After `yes`, `Where does the enabledPlugins entry go?` — `settings.json` (the default;
  `.claude/settings.json`, Claude's project scope, shared with the repository) or `settings.local.json`
  (`.claude/settings.local.json`, Claude's local scope, personal to this clone and normally not versioned; Claude
  applies it over the project file for the same plugin id). `--kanban --force` installs with every default and skips
  this question, writing `.claude/settings.json`.

Without a terminal, the flags decide:

```sh
wip init --yes
wip init --yes --force
wip init --yes --kanban --kanban-settings-file settings.local.json
```

`wip init --yes` takes the wizard's defaults, the Kanban step included: it installs the copy and writes the entry in
`.claude/settings.json` (or in the file that already holds it). The default is `no` when the entry is explicitly
`false`, when another tool's folder sits at the mod's path or when the settings cannot take the entry. `--kanban`
installs anyway (reactivating a `false` with a backup, and exiting 3 with a foreign folder); `--kanban-settings-file`
chooses the file that receives the entry and is only valid together with `--kanban`. `--global` decides where the wip
agents and skills live, never where the mod lives.

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
start a new session). The pane opens on its own as `wip Kanban`: an open no one asked for (the session's start) is
placed from 144 terminal columns, 110 once the person opened that pane before, and below that floor it waits
undrawn while a toast says why. An open the person asked for — `/wip-kanban on` or a prompt — is placed at any
width: docked beside a fullscreen transcript from 110 columns, else inline above the prompt. So `/wip-kanban on`
works on a narrow terminal too; the floor belongs to the unasked open alone. A copy installed before this version
needs `wip init --force` to get this. `/wip-kanban on` and `/wip-kanban off` open and close it, and a pane closed
by hand opens again on the next session.

### Where the pane is, and what `/wip-kanban on` answers

`/wip-kanban on` reports what the engine did with the pane, so its answer says where to look:

- `wip Kanban opened.` — the pane is placed and shown.
- `wip Kanban opened behind another pane; pick its tab.` — placed, but the surface shows another pane or tab;
  choose `wip Kanban` in the pane list.
- `wip Kanban is waiting: <reason>. The board is at <url>.` — the engine placed nothing and gives its reason
  (the column floor, no surface attached, or surfaces that place no panes). The same reason is raised as a toast,
  and the URL is the `wip web` board the rows link to: a working fallback. At the session's start an unasked pane
  that waits raises only the toast.
- `wip Kanban could not open: <reason>. The board is at <url>.` — the open itself was refused (another plugin holds
  the id, for example); the toast repeats it.

The command asks for the keyboard (`focus`); Escape hands it back. On the desktop app the pane may also be chosen
from the pane list beside the chat or the session's ⋮ menu.

## Using it

- The flow filter is the dim row at the bottom right of the pane, outside the board: one button per flow,
  `◉ <flow>` (a green fisheye) shows it, `⊘ <flow>` (a red crossed circle) hides it, one space apart; the flow's
  name stays dim. Hiding removes the flow's items and keeps its button. The list of hidden flows is kept per
  project in the mod's store, keyed by the project's absolute root, so another project is unaffected. The board
  prints no flow names; the buttons are the only place they appear. The rows and the buttons follow the project's
  flow order as `wip state --json` reports it, the same order `wip web` uses (see wip's
  [Flows](https://github.com/jupegarnica/wip/blob/main/docs/flows.md#the-order-of-the-flows-on-the-board)).
- A row is placed by the phase's ordinal: the first phase starts at the left edge, the last ends at the right
  edge, and a one-phase flow stays at the left. A label too long for the pane is cut with `…`.
- A row with `signals.attention` takes the stage's solid colour as its background with the contrasting text; any
  other row uses its flow's colour at full opacity (the phase's alpha is not applied), so a late phase stays
  legible. A phase without a stage keeps plain text, and one the flow does not declare is prefixed `! `. A linked
  row keeps those colours: the `Link` wraps the row's `Text`, so the label's own colour and background win. The
  anchor paints none itself; the surface may still decorate it (an OSC 8 span on the terminal, an anchor in the
  Desktop app and the VS Code extension), so a surface is free to tint or underline the link.
- Clicking a row opens this project's running `wip web`, found with `wip web status --json` (polled about every
  15 s), at `?item=<flow>/<id>`; the web shows that item's panel. Which address the link uses depends on the
  surface: the terminal takes the `LAN` address (`lan_url`) when the server has one and the `Local` address
  (`url`) otherwise, while the **Claude Desktop app and the VS Code extension** are drawn with the `Local` one
  (`http://localhost:<port>/`, the `webUrl` when no server answers). Those two surfaces draw a `Link` as plain
  text unless its URL is an `https:` one or an `http://localhost` one, has no `@`, and is spelled exactly as
  `new URL(href).href` returns it; a LAN address such as `http://192.168.1.59:33335/` fails that rule and would
  show the ID as text, so those surfaces never get it while a Local one exists. In the terminal the rule does not
  apply. Clicking it
  again does not open a second tab of the same origin, `localhost` or the LAN address alike: the new tab asks the
  open one for the origin, the open tab hands it over and tries to close itself (best-effort: if the browser
  refuses, it stays with a notice and no ownership), so the item opens in the tab that was just clicked (each port
  and each origin has its own tab). The rule covers any URL of the board, with or without an item; the artifact
  page (`/view/...`) is outside it and can stay open beside the board. The
  board page also shows the padlock and the poll status on the left of its header and the project name in the
  centre, between the two port chevrons (the name is also the browser tab title), with the padlock open by default.
  On a narrow screen the tabs drop below the name. With it closed the page refuses the takeover, keeps its item and
  is never closed automatically; the tab that asked shows its item with “This project is locked in another tab.”
  and stays. The padlock is kept in the tab's history entry, so a reload keeps it closed and a new tab starts open
  (duplicating the tab can copy it); it does not stop closing the tab by hand. When no server of this project runs,
  the row uses `webUrl` (default `http://localhost:33333/`) instead, so two projects on different ports each link to
  their own. The board works without the server, but the link needs `wip web` running (terminal link opening may need
  Cmd/Ctrl).

## Configuration

`claude plugin configure wip-kanban@skills-dir` (or the plugins menu) sets:

- `webUrl` — default `http://localhost:33333/`, the first port `wip web` tries. It is the base only while no
  server of this project runs: a live server always wins, whatever port it listens on (`--port`, `WIP_WEB_PORT` or
  the next free one), and contributes its `lan_url` when it has one and its `url` otherwise (the terminal takes
  the LAN one first and the Desktop app and VS Code the Local one first, as above). Use it for a remote or proxied
  URL, or for the port while no server answers. Only `http:` and `https:` URLs are accepted; an invalid one leaves
  the IDs as plain text, and on the Desktop app and VS Code only `https:` or `http://localhost` ones draw as links.
  `wip web status` may clean a stale `.wip/web` entry; wip's items and state are untouched.
- `colorScheme` — `dark` (default) or `light`: which theme's solid colours and contrasting text the attention rows
  use, and which amber fallback a stageless attention row takes. Non-attention rows use the flow tone in both
  schemes. The pane API does not expose the active theme, so this choice is explicit.

## Update, disable and remove

- Update after installing a new wip: run `wip upgrade` in the project. It updates the npm CLI and then refreshes this
  copy with the installed CLI's embedded files (by default only a copy wip owns; `--kanban` installs it and enables
  it where missing). `wip init --force` (or `wip init --kanban --force`) remains the broader refresh: it also writes
  the definitions. Either way the whole folder is replaced after copying the previous one to
  `.wip/backups/kanban/wip-kanban.<stamp>/`: managed files go back to the embedded text, your own extra files are
  removed, and the generated `.claude-plugin/types/` is kept. A second run with nothing changed says `exists` and
  writes nothing.
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
