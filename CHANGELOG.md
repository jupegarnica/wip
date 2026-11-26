# Changelog

Each version lists its changes. A version that changes the database schema says so under **Upgrade notes**: any
command of that version migrates a project's database one way (an older wip then refuses it with exit 10) and keeps
a copy of it in `.wip/backups/db/` first. While `0.x`, a schema change is a minor bump.

## 0.6.7 (2026-11-26)

- `wip init` installs a second optional Claude Code mod next to the Kanban one: **Quiet** (`--quiet`), a quieter
  transcript that hides every row that is neither the assistant's text nor the person's own messages, with
  `/wip-quiet` to show them on demand. It is a self-contained copy of `mods/wip-quiet/` in
  `.claude/skills/wip-quiet/`, travels inside the npm package and the binary, and is enabled by
  `"enabledPlugins": {"wip-quiet@skills-dir": true}` in the same settings file as the Kanban entry. `--yes` and the
  wizard's default install it. The mod draws no persistent configuration display: `/wip-quiet status` reports it,
  and only the hidden rows themselves, the folded lines after `/wip-quiet show hidden`, the message times (default
  on) and the transient hidden-error toast are drawn.
- The init wizard has six steps: Kanban is still the fifth and Quiet is the sixth. The settings-file question is
  asked at most once per run and its answer serves both mods; `--mods-settings-file settings.json|settings.local.json`
  chooses it, and `--kanban-settings-file` stays as a deprecated alias (the new flag wins when both are given).
- `wip upgrade` refreshes both owned copies by default; `--quiet`/`--no-quiet` join `--kanban`/`--no-kanban`, and
  `data.quiet` mirrors `data.kanban`.
- No database schema change: the same version opens and migrates no project.

## 0.6.6 (2026-11-25)

- The gate block of `wip-coordinate` is shorter and easier to answer: `Summary` is one phrase, a new `Context`
  section carries what the questions need, each question lists its options as `(a)`, `(b)`, `(c)`… in priority
  order with the recommended one first and a one-line reason on each, and `Risk` becomes `Risks`. Both copies of
  the skill stay byte-identical and `test/unit/templates.test.ts` quotes the new literals.

## 0.6.5 (2026-11-18)

- `wip upgrade` asks `Apply the definitions?` only when the comparison found files to write: a definitions folder
  that is up to date, or one whose only differences are another tool's files (which `apply` refuses anyway), is
  reported without a question. After an npm upgrade the freshly installed build now compares the definitions with
  its own templates and asks then, so a folder that was current for the old build still gets the new version's
  definitions; a run asks at most once, and the pre-upgrade question is unchanged. A post-upgrade step that cannot
  be applied warns `defs_failed` and exits 1 without rolling back the installed CLI, and Ctrl+C at that question
  only leaves the definitions as they are. `--apply-defs`, `--apply-defs-after`, `--check`, `--dry-run` and the
  other non-interactive paths are unchanged.

## 0.6.4 (2026-11-17)

- `wip upgrade` now asks `Apply the definitions?` in a terminal after showing the comparison, with `apply` (the
  default) and `cancel`, and writes the definitions when you accept; `--apply-defs` keeps applying without asking and
  `--no-defs` stays the opt-out. Nothing outside a terminal, with `--json`, `--check` or `--dry-run` asks, so a script
  never blocks. An accepted answer after an npm upgrade applies the freshly installed build's templates; a step that
  cannot be applied (another tool's file or a failure in the installed CLI) warns `defs_failed` and exits 1, and
  Ctrl+C at the question exits 130 with nothing upgraded.
- `wip web` keeps one tab per origin on `localhost` and on the LAN address: ownership travels over
  `BroadcastChannel` instead of Web Locks, so a plain-HTTP `http://<ip>` board deduplicates too. The owner hears
  a claim, gives up the origin and tries to close itself (best-effort, with the moved notice); padlocked tabs
  refuse and survive, a heartbeat and a stale-owner timeout replace a crashed or throttled owner, `pagehide`
  frees the origin at once, and without `BroadcastChannel` every tab is its own page as before.

## 0.6.3 (2026-11-17)

- The coordinator writes every project-relative file path in a message or `Details` starting with `./`, including a
  path that already starts with a dot (`.wip/…` becomes `./.wip/…`); a definitions folder under home stays `~/…`. The
  `Details` template, the Messages rule, the kanban fallback in `agents/wip.md` and the tasks guide follow, in both
  `.claude/` and `templates/`, and `test/unit/templates.test.ts` quotes the new wording.

## 0.6.2 (2026-11-16)

- The coordinator prints the LAN address of `wip web` whenever it shows a URL and falls back to the `Local:` one
  only when the server has none; the Kanban mod links each row to the server's `lan_url`, uses its `url` only
  without a LAN, and keeps the configured `webUrl` as the fallback while no server answers.
- `wip upgrade` compares the project's definitions folder with the templates embedded in the running build and says
  whether `wip init --force` would change anything (`defs: … out of date in .claude/ …`), with the warnings
  `defs_outdated` and `defs_foreign` and the facts in `--json` as `data.defs`. The new public `--apply-defs` applies
  that part of `wip init --force` in place — same writer, same `.wip/backups/defs/` backups, `model:` kept, another
  tool's file refuses with exit 3 — without seeding items, adding unselected flows, switching `defs_dir` or editing
  `.gitignore`; it needs no npm or registry, and `--no-defs` turns the comparison off. `--check` exits 1 when the npm
  update is available or the definitions differ; a normal run only proposes, and after an npm upgrade it points at
  `wip upgrade --apply-defs` for the freshly installed build.
- The board's header shows the project's name in the centre, flanked by two chevrons that move the board to the
  previous or next port in the same tab, changing only the port of the URL. The centre column keeps a fixed width so
  it never grows, a long name is cut with an ellipsis, the chevrons are bare icons and not buttons, and on narrow
  screens the header wraps with the view tabs on a second row.
- The gate block of `wip-coordinate` writes `Questions` as a Markdown list, one `- Q1 <question>` item per question
  with its recommendation as a two-space continuation line, and `Details` as a Markdown list, one `- ` line per
  file: an item artifact linked to its page under the kanban base, every other file as a path relative to the
  project root, and the item panel link when there is a server. The coordinator's Messages rule and the
  `agents/wip.md` and tasks-guide fallbacks ask for relative paths too, and both copies of the three definitions
  stay byte-identical.

## 0.6.1 (2026-11-13)

- The `tasks` flow gains recurring tasks: four phases — `todo` plans and waits for the next run, `doing` does the
  work with no gate, `done` holds the user's review and, with `after_review=done`, the wait, and `closed` is the
  terminal — plus the fields `schedule` (a cron expression in local time), `next_run` (an ISO 8601 instant) and
  `after_review` (`todo` or `done`). A `due` poll and a fixed-time pass at each `next_run` move a due item to
  `doing`; `doing` writes `v<N>.report.md`; after the user's OK a recurring item returns to `todo` with a new
  `next_run` and a one-off goes to `closed`. The two shipped copies, `guide.md`, `wip-coordinate`, the docs and the
  tests follow; the onboarding item now ends in `closed`.
- `wip set` accepts an ISO 8601 instant for a `ts` field (`2026-11-17T09:00:00Z` or `2026-11-17T10:00+01:00`),
  stored in UTC, next to `now` and `none`; a recurring task sets `next_run` with it.
- The coordinator's start line for the kanban shows the LAN URL next to the local one.

## 0.6.0 (2026-11-13)

- `wip upgrade` prints the CHANGELOG sections between the version it replaced and the one it installed, newest
  first, and carries the same list in `--json` as `data.changelog` (`from`, `to`, `entries`, `truncated`). The
  notes come from the target package's own `CHANGELOG.md`, which now ships in the npm package; the text block is
  capped at 40 lines and `--json` keeps every entry. A missing file or an empty range is a warning
  (`changelog_missing`, `changelog_empty`) that never changes the exit code; `--check`, `--dry-run` and an
  already-current run show none.
- `wip web` serves the board to `localhost`, `127.0.0.1` or any IPv4 literal on the port it listens on, so a
  Docker port mapping (`-p 33333:33333`) works with no environment variable or flag: the browser sends the
  address it typed. A host name, another port, an IPv6 literal or a malformed address is 403 (DNS rebinding),
  and a mapping to a different published port (`-p 8080:33333`) still is; `docs/web.md` has the Docker example.

## 0.5.1 (2026-11-13)

- CI runs on Ubuntu with Node 22 for pull requests and for a release: typecheck, lint, `bun test`, the packed
  npm package with `npm publish --dry-run` and the e2e suite against it. The full matrix (Ubuntu 22/24/26, macOS
  24, Windows 24) moved to `.github/workflows/test.yml`, which is manual (`workflow_dispatch` only) and calls
  `ci.yml` with `full: true`; nothing gates on it.
- `wip web` keeps one tab per origin for any URL of the board, not only a new page with `?item=`: the first board
  page takes the Web Locks lock, another one asks for the handover, and a newcomer that does not get it keeps its
  URL with the notice instead of closing itself. The artifact page (`/view/…`) stays outside the rule.
- The `reports` flow writes its report as `v<N>.report.md` (one version above the last one, `v1.report.md` the
  first time), because the runtime refuses a subagent `.md` artifact whose name starts with `report`, `summary`,
  `findings` or `analysis`. The flow, `wip-new-flow` and the coordinator skill say so.
- The Markdown preview renders with the vendored `marked` bundle (GFM tables, task lists, autolinks, strikethrough
  and fenced code) instead of `@garndev/markdown` and its highlighter. A YAML front matter block stays out of the
  render and is shown as plain text above it, raw HTML is allowed (the page CSP is the limit), and each artifact
  row gains a **RAW** link to the API URL that serves the file byte for byte as `text/plain`.
- `wip upgrade` updates the CLI and the Kanban mod, not the definitions folder: a project picks up the new
  `reports` flow text and the other definition changes with a fresh `wip init` or by copying them by hand.
- The release workflow publishes the npm package and makes the GitHub Release with the notes only:
  the `binaries` and `verify` jobs are gone, so a macOS runner can no longer block a publish.
  `bun scripts/build.ts --targets` still builds the binaries locally.

## 0.4.1 (2026-11-12)

- The release workflow is simpler: a `workflow_dispatch` is always a dry run (the `dry_run` input is gone) and a
  real release starts only from a `v<version>` tag, `--prerelease` is derived from the dist-tag (the `prerelease`
  output is gone), `publish` no longer installs `npm@11` in the runner, and a single `verify` job runs on Ubuntu
  with Node 22 after `publish`, waits up to 15 minutes for the version to appear in the registry before installing
  it, and fails loudly with `::error::` when it does not. `docs/releasing.md` describes the new flow.

## 0.4.0 (2026-11-12)

- `wip show` and the `wip web` item panel show two more totals: `clock_seconds` (clock time, from the item's
  creation to its archive, or to now while it is open) and `work_seconds` (work time, its local days with activity
  at most 8 h each, with the day of the archive or the current one counting from 08:00 local). Both are additive
  fields of `totals`; there is no schema change.

## 0.3.1 (2026-11-11)

- `wip upgrade` updates the npm-installed CLI from a dist-tag (`latest`, or `next` with `--channel`), verifies the
  new version by running it and rolls back a mismatch, then refreshes the current project's Kanban mod with the
  installed CLI's own embedded copy; `--check` and `--dry-run` write nothing and `--kanban` installs and enables the
  mod. It never opens a database, edits `wip_bin` or touches the definitions folder, and `version --json` gains
  `install` (`source`, `npm` or `binary`).
- `wip flow order [<flow> … | --reset]` chooses the order of the flows on the board (`flow_order` in
  `.wip/config.json`), shared by `wip web` and the Kanban mod; flows the list does not name follow alphabetically,
  and with no `flow_order` nothing changes. A malformed value only warns (`flow_order_invalid`) and leaves the board
  alphabetical.
- `wip web` keeps one tab per origin in `localhost`: a new page with `?item=` asks the open tab for the origin; the
  open tab releases it, confirms and tries to close itself (best-effort: if the browser refuses, it stays with the
  notice «This project moved to another tab.» and no ownership), and the new tab shows the item. The board alone
  does not take over: it tries to close itself and, if refused, shows «This project is open in another tab.».
  Each port has its own tab; the artifact page (`/view/`) and the LAN (or a browser without Web Locks) are not
  deduplicated.
- `wip web`: the board page shows the padlock and the poll status in the top-left of its header, where the project
  title used to be; the project name is only the browser tab title. The padlock is open by default. With it closed
  the tab refuses the takeover, keeps the project and is not closed automatically; the tab that asked shows its
  item with «This project is locked in another tab.» and stays. The padlock is kept in the tab's history entry, so
  a reload keeps it closed while a new tab starts open (duplicating the tab can copy it); its state is not shared
  between tabs, and closing the tab by hand always works.

## 0.2.1 (2026-11-10)

- The GitHub Release carries standalone binaries for macOS (`darwin-arm64`, `darwin-x64`) and Linux (`linux-x64`,
  `linux-arm64`), compiled by CI and listed in `SHA256SUMS`; they run without Node. The macOS ones are ad hoc
  signed, not notarized. Windows has no binary yet (`windows-x64` stays buildable from source with `--targets`).
- `wip web`: an artifact's preview in the item panel keeps its scroll across the 5 s refreshes, and the panel no
  longer repaints when only an open gate's wait time moves.

## 0.2.0 (2026-11-09)

First version.

- `wip web` serves its icon at `/icon.svg` (embedded with the rest of the page, not a sixth package
  file), and the README shows the wip icon.
- `wip init`'s Kanban step defaults to installing the mod (`yes`); `--yes` accepts that default, so `wip init --yes`
  and `wip init --force --yes` install the copy and the entry unless the entry is explicitly `false`, the folder is
  another tool's or the settings cannot take it. The Kanban pane reopens on the first prompt when the engine waits for
  a person to ask for it.

**Upgrade notes.** `--harness` is removed (exit 2); a `harness` key in `.wip/config.json` is ignored when read and
dropped on the next write; the definitions folder defaults to `.claude/`; a project with a legacy `defs_dir`
(`.agents`) keeps reading it, and `wip init --force` migrates it to `.claude/`.

- Per-project state in `.wip/` (SQLite) with items, flows, agent runs, gates, sessions and invariants, driven by
  `wip phase`, `set`, `wait`, `log`, `agent`, `gate`, `archive`, `session`, `show`, `state` and `check`.
- `wip prune <ID>|--archived [--dry-run --keep --report]`: moves an archived item's dependencies, builds, binaries,
  browser profiles and `tmp/` scratch to the system trash (never a hard delete), keeps its documents and writes
  `prune.md`; `wip archive` prunes by default (`--no-prune` skips it) and a missing trash only warns. `WIP_TRASH_CMD`
  sets the trash command. A failed trash is not recorded as pruned: the files stay in `.wip/tmp/wip-prune-*` and the
  next `wip prune` retries them; root-level browser profiles are reported as kept.
- Flows as skills, `<defs>/skills/wip-flow-<name>/SKILL.md`, with a `wip-flow` block, `wip flow lint` (frontmatter
  included) and the last valid version kept when an edit breaks a flow.
- `wip init`: the coordinator `wip`, the generic agents `fast`, `efficient`, `thinker` and `wise`, the skills
  `wip-coordinate`, `wip-new-flow` (with a reference flow, `example.md`), `wip-new-agent` and
  `wip-subagent-protocol`, and the `tasks` flow (stages `preparation`: intake, research, plan · `execution`:
  execute, check · `review`: review, deliver, done), in `.claude/agents` and `.claude/skills`. `.wip/config.json`
  keeps the folder and every command reads it from there.
- Agents carry their model in the templates; `wip init` never asks for or writes a model, and `--models` is removed
  (exit 2).
- `wip init --global`: writes the definitions into `~/.claude/` instead of
  the project, shared by every project initialised that way; `.wip/` stays in the project and its config keeps
  `defs_dir` as `~/.claude`. A project keeps either a local or a global folder, with no migration. In a terminal the `wip init` wizard asks the
  scope first (local by default, or global); `--global` skips the question and an initialised project keeps its scope.
  Its output and its wizard name a global folder by the absolute path `HOME` gives it, not `~/`.
- `wip init --gitignore wip,defs | none`: what goes into `.gitignore`. `wip` (the default, also with `--yes` and without a
  terminal) adds `.wip/`; `defs` adds the paths of the wip templates under the definitions folder, not the folder; `none`
  touches nothing; `defs` with `--global` is ignored with a warning. The wizard asks it as step 3/4 (definitions only in
  local scope, default no). `init` also records `wip_bin` like `wip start` (nothing under bun or node; a saved value is kept).
- The board model shared by the web and the mod lives in `src/board.ts`: stage alpha, `rgba()` colour, the two solid
  colours (over the light and the dark surface) and their contrasting texts. `wip state --json` gains the additive
  `data.board.flows`, every flow with its declared phases and columns; `data.items`, its filters and the text output
  keep their meaning, and the web page is unchanged.
- `wip init` can install the Kanban mod for Claude Code with `--kanban`: a self-contained copy of `mods/wip-kanban/`
  in `.claude/skills/wip-kanban/` (also with `--global`; it travels in the npm package and the standalone binary) and
  `"enabledPlugins": {"wip-kanban@skills-dir": true}` in the chosen settings file. The wizard's fourth step asks
  `Install the wip Kanban mod for Claude Code?` (yes by default; Enter installs the copy and the entry; no writes
  nothing) and, after yes, `Where does the enabledPlugins entry
  go?` between `.claude/settings.json` (project scope, the default, shared) and `.claude/settings.local.json` (local
  scope, personal, applied over the project file). `--kanban-settings-file settings.json|settings.local.json` fixes
  the file without questions and only goes with `--kanban`; `--kanban --force` installs with every default and skips
  the file question, writing `.claude/settings.json`. The merge preserves every other key with a backup in
  `.wip/backups/claude-settings/`; the other file is read only to warn about an override, a duplicate or an unreadable
  file. `--force` replaces the whole mod folder after copying it to `.wip/backups/kanban/`, removes extras, keeps the
  generated types and never reactivates a disabled entry unless `--kanban` is given. `--yes` takes the wizard's Kanban
  default: `wip init --yes` and `wip init --force --yes` install the copy and the entry in `.claude/settings.json`
  (or in the file that already holds it) unless the entry is explicitly `false`, the folder is another tool's or the
  settings cannot take it.
- The mod itself: a read-only pane of the project's open items read from `wip state --json` once and every 5 s
  (one process at a time, 4 s timeout, the last valid board on failure), `/wip-kanban on|off`, filters persisted per
  project, `webUrl` and `colorScheme` options, and a click that opens the wip web with the item selected. The pane
  is already open when Claude Code can place it: from 144 columns at launch, or from 110 after the person's first
  prompt; the mod reopens it on that first prompt.
- The Kanban pane paints a row that does not wait for you in its flow's colour at full opacity instead of the
  phase's translucent stage colour, so late phases stay legible on the dark pane.
- Claude Code: `claude --agent wip` starts the coordinator through its `initialPrompt`; the generic agents preload
  `wip-subagent-protocol` with their `skills` key.
- `wip start`: runs in the foreground, from the project root, the start command saved in `.wip/config.json` (`start`,
  an array of arguments with the variables `{stamp}`, `{project}`, `{root}` and `{defs}`), and exits with its code. The
  default for Claude Code is `claude --agent wip --name wip-{stamp}`, used without saving it. `--set -- <args>`,
  `--unset`, `--show` and `--dry-run` (with `--json`) manage and show it; `-- <args>` adds arguments to one launch.
  Bare `wip` launches the same command in a terminal when a project and a command are there, and prints the help
  otherwise (as before); `wip help` and `wip --help` always show the help. `wip check` warns `start_unset` and
  `start_invalid`; `init` keeps `start` when it runs again. Windows is untested.
- `wip start` records the path it was started as in `wip_bin` (the npm package's `bin/wip.mjs` passes it as
  `WIP_LAUNCH_BIN`, except on Windows), so `wip2 start` pins that command for the project; a different value is
  overwritten with a stderr line.
- `wip start` exports `WIP_BIN` with the binary path to the session it launches; the coordinator uses it instead of `wip` from the PATH.
- `from_any: true` on a phase of the `wip-flow` block makes it reachable from any non-terminal phase with a plain
  `wip phase`, no `--force` and no recorded decision; the `tasks` flow uses it on `plan`.
- A flow may have several terminal phases (`kind: terminal`): `wip flow lint` checks that every non-terminal phase can
  reach one through `next` or `from_any`. An item in any terminal waits on `none`, and web history shows an item
  archived in any terminal as `archived`.
- `color: "#RRGGBB"` at the top of the `wip-flow` block sets the tone of the flow's stage colours on the board and the
  history (blue when absent).
- Polling: a `polling` key in the `wip-flow` block (`{name, phases, agent, cadence}`, cadence `30m`, `1h`, `2d`)
  declares which agent checks which phases and how often; `wip poll due` tells any scheduler what is `DUE`,
  `OVERDUE` (unattended for more than 1.5 cadences), `OK` or `IDLE` (always exit 0, read `--json`), `wip poll record`
  logs a pass and `wip poll seen` remembers what a pass saw. wip has no cron of its own. `wip check` warns with
  `poll_overdue`. This adds schema 2 (`poll_runs`, `poll_run_items`, `poll_seen`): any command migrates a schema 1
  database, an older build then refuses it (exit 10), and `wip web` migrates it at start; restart a running
  `wip web` after upgrading.
- `wip flow disable <flow>` and `wip flow enable <flow>`: a disabled flow and its items leave `wip state`, `wip check`,
  `wip poll due`, the seeds and the board, writes on them exit 3, `wip show` still works with a `flow_disabled`
  warning and `wip flow lint` lists them as `DISABLED`. This adds schema 3 (`flows.disabled`): any command migrates
  an older database, an older build then refuses it (exit 10); restart a running `wip web` after upgrading.
- `bun run install:local --node` builds the npm package and installs its tarball with npm into `dist/local` (or
  `--prefix <dir>`) as `wip2`, without the registry and without touching the global npm; without `--node` it installs
  this machine's binary as `wip2`.
- `bun run install:global --name <name>` builds the npm package and installs it into the global npm prefix (or `--prefix <dir>`),
  replacing the installed `@garndev/wip` in place; it refuses a dirty tree (`--allow-dirty`) and another command name
  (`--replace`), never opens a project database and prints the manual backup and `<name> check` steps.
- Model onboarding: `wip check` warns with `models_unset` until each generic agent and the coordinator have a `model:`.
- Guided onboarding: a flow's `seed` lists items `wip init` creates once (an existing or archived ID is never
  touched), with `files` copied from the flow's skill folder into the item's artifacts; the `tasks` flow seeds
  `onboarding` in `intake` with `guide.md`. The coordinator mentions it in one `🟪 NEXT` suggestion and, when the
  user starts it, links the guide on the kanban, answers from it and closes it at a gate, in `done` and archived.
- `wip web`: a read-only kanban served from the binary, each stage in one blue that grows more transparent stage
  after stage (light and dark themes); each flow can be collapsed from its header, which keeps its open count and
  its «waiting on you» count, and the browser remembers the choice in `localStorage`; `--open` opens the browser on
  it, `wip web status` lists this project's servers from its registry (`.wip/web/<port>.json`), `wip web stop`
  stops them and `wip web log` shows its log (`.wip/logs/web.log`). Without `--port` it reuses this project's
  running one or serves on the first free port from 33333 to 33352.
- The coordinator brings up the kanban at the start of every session through `fast`, without waiting for it:
  `wip web status`, then `wip web --open` when this project has none running.
- Distributed as one npm package, `@garndev/wip`, that runs on Node 22.13 or later on any OS: a JavaScript bundle
  (about 190 kB packed) and the `wip` command, with no dependencies. `src/` uses only `node:*` APIs (`node:sqlite`
  through `src/sqlite.ts`, `node:http` for `wip web`, the bundled `yaml` parser), so the same code also runs on Bun
  and `scripts/build.ts --targets` compiles it locally to standalone binaries (`darwin-arm64`, `darwin-x64`,
  `linux-x64`, `linux-arm64`, `windows-x64`) for machines without Node. On Node 22 the bin hides `node:sqlite`'s ExperimentalWarning; an
  older Node exits 2 with the version it needs. The project's license is MIT.
- Before migrating a database, every command copies it as it was (`VACUUM INTO`) to
  `.wip/backups/db/wip.sqlite.v<schema>.<time>.<pid>`, so a rollback to the older wip can restore it.
- CI on pushes and pull requests (tests on Linux, macOS and Windows; the e2e suite against the packed npm package on
  Node 22, 24 and 26) and a release workflow: tag `v<version>` → tests, a gated `npm publish`, the
  GitHub Release with the CHANGELOG notes, and a check of the published version (`docs/releasing.md`). CI builds no
  binaries.
- `wip --version` prints the branch, short commit, `-dirty` mark and build date fixed by `scripts/build.ts`
  (`(source)` from source); `--json` returns them as `branch`, `commit`, `dirty`, `built_at` and `source`.
- `wip init` asks, in a terminal, in four steps (coloured only without `NO_COLOR`): the scope (`local`, the default, or
  `--global`), the `wip start` command (saved as `start`), what goes into `.gitignore`, and the Kanban mod, with a
  summary to confirm. The templates carry their `model:` lines (`haiku`, `sonnet`, `opus`, `fable` and `inherit`):
  init never asks for or writes a model, `--yes` fills no `model:` (and takes the default of each step, the Kanban one
  included), and `--models` is removed (exit 2, nothing
  written). `--start`, `--start-default` and `--no-start` answer without prompting. Without a terminal init asks
  nothing and only `start` can stay unset. `models_unset` points to the agent file without a `model:` line, fixed by
  editing that line; `start_unset` points to `wip init` or `wip start --set`. The coordinator no longer asks for
  models or `start` at startup: it points to `wip-coordinate` and changes a model only when the user asks.
- `wip cron add|list|done|cancel|snooze`: a persistent list of scheduled jobs, free-text reminders (`--item` ties one
  to an open item) and fixed-time passes of a flow poll (`--poll <flow>/<poll>`), once or repeating (`--every`, a
  cadence; `d` keeps the local hour across DST). `--at` takes UTC ISO, ISO with an offset, local `YYYY-MM-DD HH:MM` or
  `+<N>m|h|d`. `wip cron list --json` lists the open crons and the next pass of each flow poll, with stable keys, a
  `cron` expression per job, a 2-minute grace on `due`, `missed` against the open session and a 7-day horizon; the
  coordinator arms them as one-shot runtime jobs at every session start («Cron» in `wip-coordinate`) and takes its
  due polls from it. `wip poll` does not change.

### Upgrade notes

- `wip cron` adds schema 4 (`crons`): the first command migrates a schema 3 database after copying it to
  `.wip/backups/db/wip.sqlite.v3.<time>.<pid>`, and every older build then refuses the project (exit 10). For local
  builds (`wip2`, `install:local`, aliases), update every binary that opens the project; restart a running `wip web`.
