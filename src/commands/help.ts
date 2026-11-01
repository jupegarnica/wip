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
    summary:
      "Create .wip/ and the default definitions (.agents/, or .claude/ with --harness claude-code)",
    usage: ["wip init [<path>] [--force] [--harness <name>]"],
    options: ["harness"],
    flags: ["force"],
    notes: [
      "--harness claude-code writes the agents and skills straight into .claude/; any other value, or none, into .agents/.",
      "The folder is kept in .wip/config.json (defs_dir); every command reads the definitions from there.",
      "A project keeps its folder: an init that would write to another one exits 3 and writes nothing.",
      "A file at a template's path without a `wip:` mark is another tool's: exit 3 and nothing written, also with --force.",
      "--force replaces only files with a `wip:` mark, each backed up in .wip/backups/defs/; `model:` is kept.",
      "Creates the items a flow lists under `seed` (tasks: onboarding) once; an existing or archived ID is never touched.",
      "Claude Code: start the coordinator with `claude --agent wip`.",
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
    summary: "Set item fields (key=value, int +N, list +a/-a, ts now/none)",
    usage: ["wip set <ID> <key>=<value> …"],
    options: [],
    flags: [],
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
    usage: ["wip archive <ID> [--force --reason R]"],
    options: ["reason"],
    flags: ["force"],
  },
  {
    name: "session",
    summary: "Start a coordinator session; runs left running become orphaned",
    usage: ["wip session start [--id S]"],
    options: ["id"],
    flags: [],
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
    summary: "Validate the flows, the skills <defs>/skills/wip-flow-<flow>/ (exit 1 on findings)",
    usage: ["wip flow lint [<flow>]"],
    options: [],
    flags: [],
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
    summary: "Print the version",
    usage: ["wip --version"],
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
