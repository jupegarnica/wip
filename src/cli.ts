import { writeSync } from "node:fs";
import pkg from "../package.json" with { type: "json" };
import { allow, type IArgs, parseArgs } from "./args.ts";
import { BUILD_INFO, formatBuildInfo } from "./build-info.ts";
import { agentCmd } from "./commands/agent.ts";
import { archiveCmd } from "./commands/archive.ts";
import { checkCmd } from "./commands/check.ts";
import { flowCmd } from "./commands/flow.ts";
import { gateCmd } from "./commands/gate.ts";
import {
  COMMANDS,
  commandHelp,
  describeCommand,
  findCommand,
  helpCmd,
  type ICommandSpec,
} from "./commands/help.ts";
import { initCmd } from "./commands/init.ts";
import { logCmd } from "./commands/log.ts";
import { phaseCmd } from "./commands/phase.ts";
import { POLL_HANDLERS, pollCmd } from "./commands/poll.ts";
import { sessionCmd } from "./commands/session.ts";
import { setCmd } from "./commands/set.ts";
import { showCmd } from "./commands/show.ts";
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
  flow: flowCmd,
  gate: gateCmd,
  help: helpCmd,
  init: initCmd,
  log: logCmd,
  phase: phaseCmd,
  poll: pollCmd,
  session: sessionCmd,
  set: setCmd,
  show: showCmd,
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
    const handler = name === "poll" ? (POLL_HANDLERS[args.pos[0] ?? ""] ?? base) : base;
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

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (isWebServe(argv)) process.exit(await webMain(argv.slice(1)));
  const out = run(argv);
  if (out.stdout) writeAll(1, out.stdout);
  if (out.stderr) writeAll(2, out.stderr);
  process.exit(out.code);
}
