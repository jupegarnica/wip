import type { IHandler } from "../context.ts";
import { usage } from "../errors.ts";

export interface ICommandSpec {
  name: string;
  summary: string;
  usage: readonly string[];
  options: readonly string[];
  /** Options that take no value. */
  flags: readonly string[];
  notes?: readonly string[];
}

export const COMMANDS: readonly ICommandSpec[] = [
  {
    name: "init",
    summary: "Create .wip/ and the default definitions (.claude/, or ~/.claude/ with --global)",
    usage: [
      "wip init [<path>] [--global] [--force] [--yes] [--flows <names>] [--start <command> | --start-default | --no-start] [--gitignore wip,defs | none] [--kanban] [--kanban-settings-file settings.json|settings.local.json]",
    ],
    options: ["flows", "start", "gitignore", "kanban-settings-file"],
    flags: ["global", "force", "yes", "start-default", "no-start", "kanban"],
    notes: [
      "In a terminal init asks what the flags leave open, in five steps: scope (local, the default, or global; --global skips it, and an initialised project keeps its scope), the flows to write, the start command, what goes into .gitignore, and the Kanban mod (yes is the default; Enter installs it); Enter takes each default, Ctrl+C writes nothing. It asks nothing about models: the templates carry their `model:` line and init writes it as it is. With --json, without a terminal or with --yes it asks nothing.",
      "init ships four flows, `development`, `ideas`, `reports` and `tasks`, and writes all four by default: in the wizard's Flows step (2/5) all are checked (Space toggles, Enter confirms; at least one stays checked), and `--flows development,ideas,reports,tasks` selects a subset for scripts, trimmed, duplicates removed, and only names init ships (an unknown or empty value exits 2 and writes nothing). `--yes` without `--flows` writes all four; `--yes --flows tasks` writes only `tasks`, its `guide.md` and the `onboarding` item. A run adds the selected flows and never deletes a deselected or custom flow.",
      "`model:` lines come from the templates (haiku, sonnet, opus, fable and inherit for the coordinator); init never asks for or writes a model. Change one by editing `model:` in `<defs>/agents/<name>.md` (the coordinator does it with a backup in `.wip/backups/defs/agents/`); `wip check` warns `models_unset` when an agent file has none. `--yes` accepts the defaults left (local scope, the default start, `.wip/` ignored, the Kanban mod, with the same defaults the wizard shows) and keeps a saved start; it writes no `model:`.",
      "--start '<command>' saves the start command (words split with quotes; variables {stamp} {project} {root} {defs}), --start-default saves `claude --agent wip --name wip-{stamp}`, --no-start saves none. With --yes, init saves that default when no start is saved.",
      "--gitignore wip,defs | none chooses what goes into .gitignore: `wip` adds .wip/ (the default, also with --yes and without a terminal), `defs` adds the paths of the wip templates under the definitions folder (not the folder: your own files there stay out; files git already tracks stay tracked; ignored with --global, with a warning), `none` touches nothing. In a terminal init asks it as step 4/5 (defs only in local scope, default no). `.wip/` holds wip.db (binary, not mergeable), logs, ports and a config.json with the local wip_bin: versioning it is not recommended; to keep the plans, ignore `.wip/*` and add `!.wip/items/` by hand.",
      "init records the path wip was launched as in .wip/config.json (`wip_bin`), like `wip start`: the npm package records the path it was started as (not on Windows) and a compiled binary its own path; a dev run from source records nothing and keeps a saved value.",
      "--global writes the agents and skills into your home folder (~/.claude/) instead of the project, shared by every project initialised with --global; .wip/ stays in the project.",
      ".wip/config.json (defs_dir) keeps the folder: relative to the project, or ~/… for --global; every command reads the definitions from there.",
      "A project keeps its folder: an init that would write another folder of the same scope (a legacy .agents/ or ~/.agents/) exits 3 and writes nothing without --force. With --force it writes the templates into .claude/, switches defs_dir to it, leaves the old folder as it is and warns (defs_left_behind) about custom agents and skills it does not copy; a live item that uses a flow missing from the new folder exits 3 too (add a shipped flow to --flows or copy it by hand). Local and --global are never switched: exit 3, also with --force.",
      "A file at a template's path without a `wip:` mark is another tool's: exit 3 and nothing written, also with --force.",
      "--force replaces only files with a `wip:` mark, each backed up in .wip/backups/defs/; `model:` is kept.",
      "Creates the items a flow lists under `seed` once: the `tasks` flow seeds `onboarding` when it is selected, and a run without `tasks` seeds nothing; an existing or archived ID is never touched.",
      "Start the coordinator with `wip start` (or bare `wip`), which runs the start command saved in .wip/config.json or the default.",
      '--kanban installs the wip Kanban mod for Claude Code: a self-contained copy in .claude/skills/wip-kanban/ (also with --global; the destination never moves) plus "enabledPlugins": {"wip-kanban@skills-dir": true} in the chosen settings file. A new session loads it as wip-kanban@skills-dir with no flag, marketplace or download; a project copy still waits for the workspace trust dialog and needs /reload-plugins. `--kanban` installs it; a run that skips the wizard with `--yes` installs it with the defaults the wizard shows; a run with neither `--kanban` nor `--yes` never installs, updates or removes the mod.',
      "The pane opens on its own; on a terminal narrower than 144 columns Claude Code places it from your first prompt, and from then on at launch in terminals of 110 columns or more.",
      "--kanban-settings-file settings.json|settings.local.json chooses where that entry goes and only goes with --kanban (else exit 2, nothing written). The default settings.json is .claude/settings.json, Claude's project scope, shared with the repository; settings.local.json is .claude/settings.local.json, Claude's local scope, personal to this clone and not versioned by convention, and Claude applies it over the project file for the same id. Init writes only the chosen file, merges the entry preserving every other key, backs the previous text up in .wip/backups/claude-settings/, and warns when the other file overrides it (kanban_settings_overridden), disagrees (kanban_settings_duplicate) or cannot be read (kanban_settings_unreadable); the other file is never edited.",
      "The wizard's fifth step asks `Install the wip Kanban mod for Claude Code?` with yes (the default; Enter installs the copy and the entry) and no (Enter writes neither the copy nor settings); after yes it asks `Where does the enabledPlugins entry go?` with settings.json (the default) and settings.local.json. --kanban skips the first question and still asks the file; --kanban --force skips both and writes .claude/settings.json (the default); --kanban-settings-file skips the second. `--yes` installs it with the defaults the wizard shows (the copy and the `enabledPlugins` entry in `.claude/settings.json`, or in the file that already holds it); an explicit `false`, a foreign folder or settings that cannot take the entry keep it out, and `--kanban` installs anyway (or exits 3 if it cannot).",
      "--force replaces the whole mod folder after copying it to .wip/backups/kanban/wip-kanban.<stamp>/: managed files return to the embedded text, your extra files are removed (each listed as `removed`), and .claude-plugin/types/ is kept. A second --force with the same state writes nothing. --force without --kanban (and without --yes) refreshes an existing wip copy and leaves both settings files alone, so a disabled plugin stays disabled; with --yes and an explicit `false` the default the wizard shows is still no, so --force only refreshes the copy. A folder without wip's .claude-plugin/wip.json mark, or a file or link at that path, is another tool's: exit 3 with nothing written, also with --force.",
      "Disable the mod without deleting it with `claude plugin disable wip-kanban@skills-dir --scope project` (or --scope local for settings.local.json), and enable it with the same scope; the wrong scope does not reach the other file's entry. To remove it, delete .claude/skills/wip-kanban/ and, if wanted, the entry in the settings file that holds it; `claude plugin uninstall` is for marketplace installs only.",
    ],
  },
  {
    name: "upgrade",
    summary: "Update the npm-installed wip CLI and the project's Kanban mod from npm",
    usage: [
      "wip upgrade [--channel latest|next] [--check | --dry-run] [--kanban | --no-kanban] [--apply-defs | --no-defs]",
    ],
    options: ["channel"],
    flags: ["check", "dry-run", "kanban", "no-kanban", "apply-mod", "apply-defs", "no-defs"],
    notes: [
      "The CLI update is npm only: `npm install -g --prefix <this prefix> @garndev/wip@<exact version>`, with the prefix derived from the running bundle, never `npm prefix -g`. A source run, a standalone binary (use the GitHub Release), a Bun global install, an npm link, a copy outside node_modules and a package renamed with --bin-name exit 3 and name the manual command.",
      "--channel latest (the default) or next resolves that dist-tag of @garndev/wip to an exact version and installs that; a version older than the running one is reported and never installed. --check resolves it, writes nothing and exits 1 when an update is available; --dry-run prints the exact npm command and writes nothing.",
      "The version is verified by running the installed CLI (`version --json`) before anything else happens; a mismatch reinstalls the previous exact version and exits 1. The rollback restores the CLI only: a database the new version already migrated is not rolled back.",
      "After a successful upgrade the output and `data.changelog` carry the CHANGELOG sections between the replaced and the installed version (newest first, text capped at 40 lines), read from the installed package's own CHANGELOG.md; a missing file or an empty range only warns (`changelog_missing`, `changelog_empty`) and the exit code is unchanged. --check, --dry-run and an already-current run show none.",
      "The Kanban mod is refreshed with the installed CLI's own embedded copy, never merged: edited or extra files are replaced after copying the folder to `.wip/backups/kanban/wip-kanban.<stamp>/`, and `.claude-plugin/types/` is kept. The default refreshes only a copy wip owns and never enables or installs one; a missing or foreign copy is skipped. --kanban installs the copy and the enabledPlugins entry where missing or disabled, with init's preflight and backups; --no-kanban skips the step. A folder without wip's mark, or settings that cannot take the entry, exit 3 with nothing written.",
      "It never opens, creates or migrates a project database, never edits `.wip/config.json` (a `wip_bin` pointing elsewhere only warns `wip_bin_pinned`), never touches another project and never runs sudo. Run it in each project to refresh that project's copy.",
      "The definitions folder is compared with the templates embedded in the running build and reported, never written unless you ask with `--apply-defs`: `defs: up to date (.claude/)` or `defs: 2 out of date in .claude/ (1 changed, 1 missing); run `wip upgrade --apply-defs`, then one line per file (`changed`, `missing`, `foreign`) and `kept N custom definitions (not touched)`; the warnings are `defs_outdated` and `defs_foreign`, and `data.defs` carries the same facts. The comparison is what `wip init --force` would write, so a `model:` edit is not drift; a file without a `wip:` mark (or a directory or a symlink at a template path) is another tool's and blocks the refresh (exit 3, nothing written, the file named), and a custom agent or skill is never deleted. Only the flows whose `skills/wip-flow-<name>/` folder exists are compared, and every shipped flow when the folder has none (a wiped folder is repaired), so a project initialised with `--flows tasks` is never offered the other flows. It compares and writes the configured `defs_dir`, local or `~/…` from `--global` (the shared folder is named and the backups stay in the running project). `--apply-defs` writes in place through the same writer and with the same backups as `wip init --force` (`.wip/backups/defs/`), but seeds no items, adds no unselected flow, never switches `defs_dir` and never edits `.gitignore`; it takes no `--check`, `--dry-run`, `--channel`, `--kanban` nor `--no-defs` (exit 2) and works from a source run and from a binary. `--no-defs` turns the comparison off and `data.defs` is null. `wip upgrade` never opens the database, so it cannot read `flows.disabled`: a disabled flow's files are compared and refreshed like any other flow's and the flow stays disabled.",
      "Exit codes: 0 upgraded, up to date, --dry-run printed, --apply-defs applied or current, or the internal mod step done · 1 --check found an update or outdated definitions, the npm install or verification failed, or the CLI was upgraded but the mod was not · 2 usage, including --apply-defs with --check, --dry-run, --channel, --kanban or --no-defs · 3 refused before any write (this install, the registry or --kanban's preflight, or a foreign file with --apply-defs) · 4 --kanban, --apply-defs or the internal mod step in a directory without a .wip/. After a mod update, reload plugins or restart Claude Code (/reload-plugins).",
    ],
  },
  {
    name: "phase",
    summary: "Create an item or move it to the next phase of its flow",
    usage: [
      "wip phase <ID> <phase> [--flow F] [--wait W] [--next T] [--note T] [--force --reason R]",
    ],
    options: ["flow", "wait", "next", "note", "reason"],
    flags: ["force"],
    notes: [
      "A phase with `from_any: true` in the flow is reachable from any non-terminal phase without --force.",
    ],
  },
  {
    name: "set",
    summary: "Set item fields (key=value, int +N, list +a/-a, ts now/none/ISO 8601)",
    usage: ["wip set <ID> <key>=<value> …"],
    options: [],
    flags: [],
    notes: [
      "A `ts` field takes `now`, `none` (clears it) or an ISO 8601 instant with a `Z` or a `±HH:MM` offset, stored as UTC: `2026-11-17T09:00:00Z`, `2026-11-17T10:00+01:00`.",
    ],
  },
  {
    name: "wait",
    summary: "Record who the item waits on",
    usage: ["wip wait <ID> <user|external|none|agent:<a>[,<b>]> [--next T]"],
    options: ["next"],
    flags: [],
  },
  {
    name: "log",
    summary: "Add a note to the item's history",
    usage: ['wip log <ID> "<text>" [--kind note|user|milestone:<name>]'],
    options: ["kind"],
    flags: [],
  },
  {
    name: "show",
    summary: "Show one item with its runs, gates, history and totals",
    usage: ["wip show <ID> [--log N | --since ISO]"],
    options: ["log", "since"],
    flags: [],
  },
  {
    name: "state",
    summary: "List items and what each one waits on",
    usage: ["wip state [--flow F] [--waiting W] [--attention] [--archived] [--grep T]"],
    options: ["flow", "waiting", "grep"],
    flags: ["attention", "archived"],
  },
  {
    name: "agent",
    summary: "Record a subagent run starting or finishing",
    usage: [
      "wip agent start <ID> <agent> [--phase F] [--handle H]",
      "wip agent stop <ID> <agent|handle> --status done|blocked|needs-input|stopped [--summary T] [--next T]",
    ],
    options: ["phase", "handle", "status", "summary", "next"],
    flags: [],
  },
  {
    name: "gate",
    summary: "Open or close a user decision on an item",
    usage: [
      "wip gate open <ID> [<phase>] --question Q [--detail PATH]",
      "wip gate close <ID> [<phase>] --answer A [--decision D] [--wait W] [--next T]",
    ],
    options: ["question", "detail", "answer", "decision", "wait", "next"],
    flags: [],
  },
  {
    name: "archive",
    summary: "Archive an item with no running agents nor open gates",
    usage: ["wip archive <ID> [--force --reason R] [--no-prune]"],
    options: ["reason"],
    flags: ["force", "no-prune"],
    notes: [
      "Archiving also prunes the item folder to the system trash (see `wip prune`); --no-prune keeps it whole.",
      "A missing trash command or a prune error never fails the archive: it is a warning, repeat with `wip prune <ID>`.",
    ],
  },
  {
    name: "prune",
    summary: "Move an archived item's dependencies, builds and tmp/ scratch to the system trash",
    usage: [
      "wip prune <ID> [--dry-run] [--keep P,P] [--report FILE.md]",
      "wip prune --archived [--flow F] [--dry-run] [--keep ABS,ABS] [--report FILE.md]",
    ],
    options: ["flow", "keep", "report"],
    flags: ["dry-run", "archived"],
    notes: [
      "Rules: D1 storybook-static · D2 Mach-O/ELF binaries of 1 MB or more in tmp/ · D3 node_modules · D4 browser profiles ·",
      "  D5 __pycache__, *.pyc, .DS_Store · D6 *.sqlite, *.db in tmp/ · D7 the rest of tmp/ unless a .md cites it (R1 media, R2 text).",
      "Every entry at the root of the item folder stays, and so do its documents, symbolic links and prune.md.",
      "Only archived items whose folder is .wip/items/<flow>/<ID>; an open item exits 3. Nothing is deleted: it goes to one",
      "  `wip-prune-<ts>` folder (staged in .wip/tmp/) sent to the trash: macOS /usr/bin/trash, Linux gio trash or trash-put,",
      "  Windows the recycle bin. WIP_TRASH_CMD (an executable path) replaces it; with none, exit 3.",
      "--keep keeps files of tmp/ (relative to the item folder; absolute with --archived), never a browser profile (D4).",
      "--dry-run only lists (and writes --report); it never touches the database. --report needs an absolute path.",
      "Writes prune.md in the item folder and a `pruned` milestone. Exit 1 when something failed to move (staging stays in .wip/tmp/).",
    ],
  },
  {
    name: "session",
    summary: "Start a coordinator session; runs left running become orphaned",
    usage: ["wip session start [--id S]"],
    options: ["id"],
    flags: [],
  },
  {
    name: "start",
    summary:
      "Start the coordinator: run the saved start command in the foreground (exit with its code)",
    usage: [
      "wip start [-- <args>]",
      "wip start --dry-run [-- <args>] [--json]",
      "wip start --show [--json]",
      "wip start --set -- <command> <arg> …",
      "wip start --unset",
    ],
    options: [],
    flags: ["set", "unset", "show", "dry-run"],
    notes: [
      "Runs from the project root, with the terminal inherited; Ctrl-C reaches the runtime, and wip exits with its code.",
      "The command is an array of arguments, never a shell line. Variables: {stamp} (local time YY-MM-DD-hh-mm), {project}, {root}, {defs}; {{ and }} are literal braces.",
      "Without a saved command, Claude Code gets `claude --agent wip --name wip-{stamp}` (not saved); the default is always available.",
      "--set validates and saves in .wip/config.json; --unset removes it; --dry-run and --show print the expanded command and need no terminal.",
      "Needs a terminal on stdin and stdout, and is refused inside a session wip started (WIP_START is set): exit 2.",
      "Each launch records the path it was started as in .wip/config.json (wip_bin), replacing a different one; a stderr line says so. The npm package records the path it was started as (not on Windows); a dev run from source records nothing and keeps a saved value. The session gets `WIP_BIN` with the binary path (from `wip_bin`), which the coordinator runs as `wip`.",
      "Bare `wip` runs the same command when it can (terminal, project, command); otherwise it prints the help, as `wip help` does.",
    ],
  },
  {
    name: "check",
    summary: "Check the invariants of every item or of one (exit 1 on findings)",
    usage: ["wip check [<ID>]"],
    options: [],
    flags: [],
  },
  {
    name: "flow",
    summary:
      "Validate, disable and enable the flows, and choose their order on the board (the skills <defs>/skills/wip-flow-<flow>/, lint exits 1 on findings)",
    usage: [
      "wip flow lint [<flow>]",
      "wip flow disable <flow>",
      "wip flow enable <flow>",
      "wip flow order [<flow> … | --reset]",
    ],
    options: [],
    flags: ["reset"],
  },
  {
    name: "poll",
    summary: "Which scheduled checks of the flows are due, record a pass, remember what a pass saw",
    usage: [
      "wip poll due [--flow F]",
      "wip poll record <flow> <poll> [--items A,B | --items none] [--result T] [--agent A]",
      "wip poll seen <flow> <poll> [<key> [--until ISO|+Nh|+Nd] [--note T] | <key> --remove] [--all]",
    ],
    options: ["flow", "items", "result", "agent", "until", "note"],
    flags: ["remove", "all"],
    notes: [
      "A flow declares `polling: [{name, phases, agent, cadence}]`; wip never runs it: any scheduler asks `wip poll due`.",
      "due: DUE (its cadence passed) · OVERDUE (due and unattended for more than 1.5 cadences) · OK · IDLE (no open item in its phases).",
      "  A poll without phases is flow-wide (discovery) and always applies. Always exit 0: scripts read --json (data.polls[].due).",
      "record: one pass at the CLI's clock; items default to the ones `due` lists; it writes no item event.",
      "seen: a key the pass saw and did not turn into an item; with --until it is forgotten then, without it for good.",
      "  Without a key it lists the active keys (--all: also the expired ones).",
    ],
  },
  {
    name: "cron",
    summary: "Scheduled reminders and fixed-time poll passes, kept across sessions",
    usage: [
      'wip cron add "<text>" --at <when> [--every <cadence>] [--item <ID>]',
      'wip cron add --poll <flow>/<poll> --at <when> [--every <cadence>] ["<text>"]',
      "wip cron list [--all] [--horizon <cadence>]",
      "wip cron done <cN>",
      "wip cron cancel <cN>",
      "wip cron snooze <cN> --at <when>",
    ],
    options: ["at", "every", "item", "poll", "horizon"],
    flags: ["all"],
    notes: [
      "--at: UTC ISO (2026-11-06T13:00:00Z), ISO with an offset (2026-11-06T14:00+01:00), local YYYY-MM-DD HH:MM",
      "  (this machine's time zone) or +<N>m, +<N>h, +<N>d. A time that is not in the future is exit 2.",
      "--every: a cadence counted from --at (30m, 1h, 7d); d moves local calendar days, so 14:00 stays 14:00 across DST.",
      "--item: an open item (archived: exit 3, unknown: exit 4). The text is one line of 1 to 500 characters.",
      "list: open crons sorted by time, with the next pass of each flow poll; --all adds done and cancelled ones.",
      "  A job is due 2 minutes before its time (the grace); missed: due before the open session started.",
      "  --horizon (7d) bounds the jobs listed; data.beyond counts the later ones and data.rearm says when to read again.",
      "done: a one-off cron is done; a repeating one moves to its first occurrence after now. cancel closes it for good.",
      "  done, cancel and snooze on a closed cron exit 3; an unknown cN exits 4.",
      "wip never fires a cron: the coordinator arms them in its runtime at every session start (a reminder, not an alarm).",
    ],
  },
  {
    name: "web",
    summary:
      "Serve the project's kanban, read-only; check, stop or read the log of the running one",
    usage: [
      "wip web [--port N] [--open] [--local]",
      "wip web status",
      "wip web stop [--port N]",
      "wip web log [-n N] [--follow]",
    ],
    options: ["port", "lines"],
    flags: ["open", "local", "follow"],
    notes: [
      "Without --port, wip web reuses this project's running one, or serves on the first free port from 33333",
      "  to 33352 (WIP_WEB_PORT moves the first one); --port N serves on exactly N.",
      "Host: only localhost, 127.0.0.1 or an IPv4 literal on the served port reaches the board; a host name or",
      "  another port is 403 (DNS rebinding). No variable or flag: the published address works as it is.",
      "Each server records itself in .wip/web/<port>.json while it serves.",
      "--open opens http://localhost:<port>/ in the browser once it serves, or if it already does.",
      "status lists this project's servers from .wip/web/ (PORT · PID · URL) and asks no other port:",
      "  exit 0 at least one answers · 1 none.",
      "stop sends SIGTERM to every server of this project (--port N: only that one, if it is recorded) and",
      "  waits up to 10 s each: 0 stopped · 1 none was running · 3 one did not stop.",
      "log: the last N lines (50) of .wip/logs/web.log: start, addresses, responses ≥ 400, errors and stop;",
      "  --follow keeps printing new lines until Ctrl-C; exit 4 when there is no log yet.",
      "  Past 1 MB the log moves to web.log.1.",
    ],
  },
  {
    name: "help",
    summary: "List the commands, or show one",
    usage: ["wip help [<command>]", "wip <command> --help"],
    options: [],
    flags: [],
  },
  {
    name: "version",
    summary: "Print the version, branch and commit of this build",
    usage: ["wip --version [--json]"],
    options: [],
    flags: [],
  },
];

export function findCommand(
  name: string,
  commands: readonly ICommandSpec[] = COMMANDS,
): ICommandSpec | undefined {
  return commands.find((spec) => spec.name === name);
}

export function overview(commands: readonly ICommandSpec[] = COMMANDS): string {
  const width = Math.max(...commands.map((spec) => spec.name.length));
  const rows = commands.map((spec) => `  ${spec.name.padEnd(width)}  ${spec.summary}`);
  return [
    "Usage: wip <command> [arguments] [--json]",
    "",
    "Commands:",
    ...rows,
    "",
    "Every command accepts --json (envelope: ok, item, events, warnings, message, data) and --help.",
    "Exit codes: 0 ok · 1 findings · 2 usage · 3 rejected · 4 not found (or no .wip/) · 10 database.",
  ].join("\n");
}

export function commandHelp(spec: ICommandSpec): string {
  const notes = spec.notes ? ["", ...spec.notes] : [];
  return [
    `${spec.summary}.`,
    "",
    "Usage:",
    ...spec.usage.map((line) => `  ${line}`),
    ...notes,
  ].join("\n");
}

export function describeCommand(spec: ICommandSpec): Record<string, unknown> {
  return { name: spec.name, summary: spec.summary, usage: spec.usage };
}

export const helpCmd: IHandler = {
  db: "none",
  run: (ctx, args) => {
    const [name, extra] = args.pos;
    if (extra !== undefined) throw usage("wip help takes at most one command");
    if (name === undefined) {
      ctx.result.lines.push(overview());
      ctx.result.data = { commands: COMMANDS.map(describeCommand) };
      return;
    }
    const spec = findCommand(name);
    if (!spec) throw usage(`unknown command '${name}'; run \`wip help\``);
    ctx.result.lines.push(commandHelp(spec));
    ctx.result.data = { command: describeCommand(spec) };
  },
};
