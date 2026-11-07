import { writeSync } from "node:fs";
import pkg from "../package.json" with { type: "json" };
import { allow, type IArgs, parseArgs } from "./args.ts";
import { BUILD_INFO, formatBuildInfo } from "./build-info.ts";
import { agentCmd } from "./commands/agent.ts";
import { archiveCmd } from "./commands/archive.ts";
import { checkCmd } from "./commands/check.ts";
import { CRON_HANDLERS, cronCmd } from "./commands/cron.ts";
import { FLOW_HANDLERS, flowCmd } from "./commands/flow.ts";
import { gateCmd } from "./commands/gate.ts";
import {
  COMMANDS,
  commandHelp,
  describeCommand,
  findCommand,
  helpCmd,
  type ICommandSpec,
} from "./commands/help.ts";
import { initCmd, isInitPrompt, promptInit } from "./commands/init.ts";
import { logCmd } from "./commands/log.ts";
import { phaseCmd } from "./commands/phase.ts";
import { POLL_HANDLERS, pollCmd } from "./commands/poll.ts";
import { pruneRead, pruneWrite } from "./commands/prune.ts";
import { sessionCmd } from "./commands/session.ts";
import { setCmd } from "./commands/set.ts";
import { showCmd } from "./commands/show.ts";
import { canLaunchBare, startCmd, startLaunch } from "./commands/start.ts";
import { stateCmd } from "./commands/state.ts";
import { waitCmd } from "./commands/wait.ts";
import { webMain } from "./commands/web.ts";
import { envelope, type ICtx, type IHandler, type IResult, newResult } from "./context.ts";
import { type IOpenOptions, openDb, openForRead, type TDatabase } from "./db.ts";
import { findRoot, type IRoot, type TEnv } from "./env.ts";
import { EXIT, type TExitCode, usage, WipError } from "./errors.ts";

export const VERSION: string = pkg.version;

const versionCmd: IHandler = {
  db: "none",
  run: (ctx) => {
    ctx.result.lines.push(formatBuildInfo(BUILD_INFO));
    ctx.result.data = { ...BUILD_INFO };
  },
};

export const HANDLERS: Readonly<Record<string, IHandler>> = {
  agent: agentCmd,
  archive: archiveCmd,
  check: checkCmd,
  cron: cronCmd,
  flow: flowCmd,
  gate: gateCmd,
  help: helpCmd,
  init: initCmd,
  log: logCmd,
  phase: phaseCmd,
  poll: pollCmd,
  prune: pruneWrite,
  session: sessionCmd,
  set: setCmd,
  show: showCmd,
  start: startCmd,
  state: stateCmd,
  version: versionCmd,
  wait: waitCmd,
  web: {
    db: "none",
    run: () => {
      throw usage("`wip web` serves in the foreground: run it from the command line");
    },
  },
};

/** `wip web` (not its --help) is asynchronous and long-lived: the entry point runs it outside run(). */
export function isWebServe(argv: readonly string[]): boolean {
  const [first, ...rest] = argv;
  const dashdash = rest.indexOf("--");
  const head = dashdash < 0 ? rest : rest.slice(0, dashdash);
  return first === "web" && !head.includes("--help") && !head.includes("-h");
}

const START_MODE_FLAGS = ["--set", "--unset", "--show", "--dry-run"];

/**
 * `wip start` (not its help nor the modes that do not launch), and bare `wip` when it is safe to launch: a terminal
 * on stdin and stdout, no session started by wip (WIP_START), a project, and a usable start command. Otherwise bare
 * `wip` is the help, as before. Like `wip web`, the launch runs outside run(), which is synchronous.
 */
export function isStartLaunch(
  argv: readonly string[],
  env: TEnv,
  tty: boolean,
  cwd: string,
): boolean {
  if (argv.length === 0) return tty && env.WIP_START === undefined && canLaunchBare(cwd, env);
  const [first, ...rest] = argv;
  if (first !== "start") return false;
  const dashdash = rest.indexOf("--");
  const head = dashdash < 0 ? rest : rest.slice(0, dashdash);
  if (head.includes("--help") || head.includes("-h")) return false;
  return !head.some((a) => START_MODE_FLAGS.includes(a));
}

export interface IRunOutput {
  code: TExitCode;
  stdout: string;
  stderr: string;
}

export interface IRunOptions extends IOpenOptions {
  cwd?: string;
  env?: TEnv;
  /** Test-only: commands added to the catalogue, each with its handler. */
  extra?: readonly { spec: ICommandSpec; handler: IHandler }[];
}

const ALIASES: Readonly<Record<string, string>> = {
  "--version": "version",
  "-v": "version",
  "--help": "help",
  "-h": "help",
};

export function run(argv: readonly string[], options: IRunOptions = {}): IRunOutput {
  const [first, ...rest] = argv;
  const name = first === undefined ? "help" : (ALIASES[first] ?? first);
  const dashdash = rest.indexOf("--");
  const head = dashdash < 0 ? rest : rest.slice(0, dashdash);
  const json = head.includes("--json");
  const result = newResult();
  try {
    const commands = [...COMMANDS, ...(options.extra ?? []).map((e) => e.spec)];
    const spec = findCommand(name, commands);
    if (!spec) throw usage(`unknown command '${name}'; run \`wip help\``);
    if (head.includes("--help") || head.includes("-h")) {
      result.lines.push(commandHelp(spec));
      result.data = { command: describeCommand(spec) };
      return output(result, json);
    }
    const args = parseArgs(rest, spec.flags);
    allow(args, [...spec.options, ...spec.flags]);
    const base = options.extra?.find((e) => e.spec.name === name)?.handler ?? HANDLERS[name];
    const bySub =
      name === "poll"
        ? POLL_HANDLERS
        : name === "flow"
          ? FLOW_HANDLERS
          : name === "cron"
            ? CRON_HANDLERS
            : null;
    const picked = bySub ? (bySub[args.pos[0] ?? ""] ?? base) : base;
    // `wip prune --dry-run` only reads: it must not create the database.
    const handler = name === "prune" && args.flags.has("dry-run") ? pruneRead : picked;
    if (!handler) throw usage(`\`wip ${name}\` is not available in this build yet`);
    execute(handler, args, result, options);
  } catch (err) {
    return failure(err, json);
  }
  return output(result, json);
}

interface IHandles {
  root: IRoot | null;
  db: TDatabase | null;
  readDb: TDatabase | null | undefined;
}

function execute(handler: IHandler, args: IArgs, result: IResult, options: IRunOptions): void {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const open: IOpenOptions = { sqliteVersion: options.sqliteVersion };
  const h: IHandles = { root: null, db: null, readDb: undefined };
  const ctx: ICtx = {
    result,
    cwd,
    env,
    get root(): IRoot {
      h.root ??= findRoot(cwd, env);
      return h.root;
    },
    get db(): TDatabase {
      if (handler.db !== "write") throw new Error("ctx.db is only for write commands");
      if (!h.db) {
        h.db = openDb(ctx.root.db, open);
        h.db.exec("BEGIN IMMEDIATE");
      }
      return h.db;
    },
    get readDb(): TDatabase | null {
      if (handler.db !== "read") throw new Error("ctx.readDb is only for read commands");
      if (h.readDb === undefined) h.readDb = openForRead(ctx.root.db, open);
      return h.readDb;
    },
  };
  try {
    handler.run(ctx, args);
    if (h.db?.inTransaction) h.db.exec("COMMIT");
  } catch (err) {
    if (h.db?.inTransaction) h.db.exec("ROLLBACK");
    throw err;
  } finally {
    h.db?.close();
    h.readDb?.close();
  }
}

function output(result: IResult, json: boolean): IRunOutput {
  if (json) {
    return { code: result.code, stdout: `${JSON.stringify(envelope(result))}\n`, stderr: "" };
  }
  const lines = result.lines.length > 0 ? result.lines : result.message ? [result.message] : [];
  return {
    code: result.code,
    stdout: lines.map((line) => `${line}\n`).join(""),
    stderr: result.warnings.map((w) => `warning: ${w.message}\n`).join(""),
  };
}

function failure(err: unknown, json: boolean): IRunOutput {
  const code: TExitCode = err instanceof WipError ? err.code : EXIT.DB;
  const message = err instanceof Error ? err.message : String(err);
  const stderr = `wip: ${message}\n`;
  if (!json) return { code, stdout: "", stderr };
  const result = newResult();
  result.ok = false;
  result.code = code;
  result.message = message;
  result.data = { code };
  return { code, stdout: `${JSON.stringify(envelope(result))}\n`, stderr };
}

function writeAll(fd: number, text: string): void {
  const buffer = Buffer.from(text, "utf8");
  for (let offset = 0; offset < buffer.length; ) offset += writeSync(fd, buffer, offset);
}

/**
 * The whole CLI for one process: writes to stdout and stderr and resolves to the exit code. The caller exits with it
 * (`src/main.ts` under Bun and in the binary, `bin/wip.mjs` in the npm package).
 */
export async function main(argv: readonly string[]): Promise<number> {
  if (isWebServe(argv)) return webMain(argv.slice(1));
  const cwd = process.cwd();
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (isStartLaunch(argv, process.env, tty, cwd)) {
    const rest = argv[0] === "start" ? argv.slice(1) : [];
    return startLaunch(rest, cwd, process.env, tty);
  }
  let toRun = argv;
  if (isInitPrompt(argv, tty)) {
    const asked = await promptInit(argv, cwd, process.env);
    if (asked.argv === null) return asked.code;
    toRun = asked.argv;
  }
  const out = run(toRun);
  if (out.stdout) writeAll(1, out.stdout);
  if (out.stderr) writeAll(2, out.stderr);
  return out.code;
}
