import { spawn } from "node:child_process";
import { homedir, constants as osConstants } from "node:os";
import { basename, isAbsolute, resolve as resolvePath } from "node:path";
import type { IArgs } from "../args.ts";
import { now } from "../clock.ts";
import {
  defaultStart,
  parseStartTemplate,
  readConfig,
  readStart,
  type TStartPiece,
  validateStart,
  writeConfig,
} from "../config.ts";
import type { ICtx, IHandler } from "../context.ts";
import { defsPath, findRoot, type IRoot, type TEnv } from "../env.ts";
import { EXIT, usage, WipError } from "../errors.ts";

/** Set in the environment of every runtime `wip start` launches: a session started by wip never starts another. */
export const WIP_START_ENV = "WIP_START";

/** Set by the npm package's bin (bin/wip.mjs) to the path it was started as (an npm link on PATH, such as wip2). */
export const WIP_LAUNCH_BIN_ENV = "WIP_LAUNCH_BIN";

/** Set in the environment of the launched session to the wip binary the coordinator runs as `wip` (`wip_bin`). */
export const WIP_BIN_ENV = "WIP_BIN";

export const START_MODES = ["set", "unset", "show", "dry-run"] as const;

/**
 * The path of the wip binary a launch records as `wip_bin`: the launcher's path (WIP_LAUNCH_BIN, resolved against
 * `cwd` if relative, never realpath'd), else the running executable when it is a standalone binary. Under bun or
 * node (a dev run) it is null: nothing is recorded.
 */
export function launchBin(env: TEnv, execPath: string, cwd: string): string | null {
  const shim = env[WIP_LAUNCH_BIN_ENV]?.trim();
  if (shim) return isAbsolute(shim) ? shim : resolvePath(cwd, shim);
  if (/^(bun|node)(\.exe)?$/i.test(basename(execPath))) return null;
  return isAbsolute(execPath) ? execPath : null;
}

export interface IWipBinSync {
  changed: boolean;
  from: string | null;
  to: string;
  /** Set when the config could not be read or written: the launch goes on without recording. */
  warning: string | null;
}

/** Sets `wip_bin` to `bin` when it differs (overwrites any other value); the other keys stay as they are. */
export function syncWipBin(project: string, bin: string): IWipBinSync {
  let from: string | null;
  try {
    from = readConfig(project)?.wip_bin ?? null;
  } catch (err) {
    return { changed: false, from: null, to: bin, warning: messageOf(err) };
  }
  if (from === bin) return { changed: false, from, to: bin, warning: null };
  try {
    writeConfig(project, { wip_bin: bin });
  } catch (err) {
    return { changed: false, from, to: bin, warning: messageOf(err) };
  }
  return { changed: true, from, to: bin, warning: null };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The value of WIP_BIN for the launched session, read after `recordWipBin`: the stored `wip_bin` (`~/…` expanded,
 * relative resolved against the project root, never realpath'd), else `launched` when the config cannot be read or
 * has no value, else null (the session then uses `wip` from the PATH).
 */
export function childWipBin(project: string, launched: string | null): string | null {
  let stored: string | null;
  try {
    stored = readConfig(project)?.wip_bin ?? null;
  } catch {
    return launched;
  }
  if (stored === null) return launched;
  if (stored.startsWith("~/")) return resolvePath(homedir(), stored.slice(2));
  return isAbsolute(stored) ? stored : resolvePath(project, stored);
}

/**
 * Records the launch path (see `syncWipBin`), reports on stderr only when the value changes or fails, and returns
 * the launched path (null in a dev run).
 */
function recordWipBin(project: string, cwd: string, env: TEnv): string | null {
  const bin = launchBin(env, process.execPath, cwd);
  if (bin === null) return null;
  const sync = syncWipBin(project, bin);
  if (sync.warning !== null) {
    process.stderr.write(`🟨 could not save wip_bin: ${sync.warning}\n`);
  } else if (sync.changed && sync.from === null) {
    process.stderr.write(`🟨 wip_bin set to ${bin} in .wip/config.json\n`);
  } else if (sync.changed) {
    process.stderr.write(`🟨 wip_bin changed from ${sync.from} to ${bin} in .wip/config.json\n`);
  }
  return bin;
}

/** `YY-MM-DD-hh-mm` in local time: the stamp of a session name. */
export function startStamp(date: Date = now()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return [
    p(date.getFullYear() % 100),
    p(date.getMonth() + 1),
    p(date.getDate()),
    p(date.getHours()),
    p(date.getMinutes()),
  ].join("-");
}

export interface IStartVars {
  stamp: string;
  project: string;
  root: string;
  defs: string;
}

export function startVars(root: IRoot, env: TEnv, date: Date = now()): IStartVars {
  return {
    stamp: startStamp(date),
    project: basename(root.project),
    root: root.project,
    defs: defsPath(root.project, root.defsDir, env),
  };
}

/** Substitutes the variables inside each element; never splits or joins elements. */
export function expandStart(template: readonly string[], vars: IStartVars): string[] {
  return template.map((arg) =>
    parseStartTemplate(arg)
      .map((piece: TStartPiece) => ("literal" in piece ? piece.literal : vars[piece.variable]))
      .join(""),
  );
}

export interface IResolvedStart {
  template: string[];
  origin: "config" | "default";
}

/** The saved `start`, else the default Claude Code command (not saved). */
export function resolveStart(project: string): IResolvedStart {
  const configured = readStart(project);
  if (configured !== null) return { template: configured, origin: "config" };
  return { template: defaultStart(), origin: "default" };
}

/** A project for `wip start`: `.wip/` must exist, else a usage error that names `wip init`. */
export function projectFor(cwd: string, env: TEnv): IRoot {
  try {
    return findRoot(cwd, env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw usage(`${message.split(";")[0]}: run \`wip init\` first`);
  }
}

/** Shows an argument the way a shell would take it back, quoted only when needed. */
function shown(argv: readonly string[]): string {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a))).join(" ");
}

export interface IStartOutcome {
  ok: boolean;
  lines: string[];
  message: string | null;
  data: Record<string, unknown>;
}

/** The modes that do not launch: each one prints or writes and returns. */
export function startMode(
  mode: (typeof START_MODES)[number] | null,
  pos: readonly string[],
  cwd: string,
  env: TEnv,
): IStartOutcome {
  const root = projectFor(cwd, env);
  const extras = mode === "set" ? [] : [...pos];
  if (mode === "set") {
    const template = validateStart(pos);
    writeConfig(root.project, { start: template });
    const vars = startVars(root, env);
    const sample = expandStart(template, vars);
    return {
      ok: true,
      lines: [`saved start: ${shown(template)}`, `expands to: ${shown(sample)}`],
      message: `start saved in ${root.wip}/config.json`,
      data: { start: template, expanded: sample, origin: "config" },
    };
  }
  if (mode === "unset") {
    writeConfig(root.project, { start: null });
    const fallback = defaultStart();
    return {
      ok: true,
      lines: [`removed start; \`wip start\` now uses the default: ${shown(fallback)}`],
      message: "start removed",
      data: { start: null, fallback },
    };
  }
  const resolved = resolveStart(root.project);
  const argv = [...expandStart(resolved.template, startVars(root, env)), ...extras];
  return {
    ok: true,
    lines: [shown(argv), `origin: ${resolved.origin}`],
    message: null,
    data: {
      template: resolved.template,
      origin: resolved.origin,
      argv,
      extra: extras,
    },
  };
}

function run(ctx: ICtx, args: IArgs): void {
  const chosen = START_MODES.filter((m) => args.flags.has(m));
  if (chosen.length > 1) throw usage(`choose one of ${chosen.map((m) => `--${m}`).join(", ")}`);
  const mode = chosen[0] ?? null;
  if (mode === null) {
    throw usage("`wip start` runs the coordinator in the foreground: run it from a terminal");
  }
  if (mode === "unset" && args.pos.length > 0) throw usage("--unset takes no arguments");
  const out = startMode(mode, args.pos, ctx.cwd, ctx.env);
  ctx.result.lines.push(...out.lines);
  ctx.result.message = out.message;
  ctx.result.data = out.data;
}

export const startCmd: IHandler = { db: "none", run };

/** `wip start` in the foreground: the arguments after `--` are extra arguments of the launch. */
export function launchExtras(rest: readonly string[]): string[] {
  const dashdash = rest.indexOf("--");
  if (dashdash < 0) {
    if (rest.length > 0) throw usage("extra arguments go after --: wip start -- <args>");
    return [];
  }
  if (dashdash > 0) throw usage(`unknown argument ${rest[0]}; wip start takes only -- <args>`);
  return rest.slice(1);
}

function runChild(argv: readonly string[], cwd: string, env: TEnv): Promise<number> {
  return new Promise((resolveExit) => {
    // The terminal sends SIGINT to the whole foreground group: the child gets it, wip waits for the child.
    const ignore = () => {};
    process.on("SIGINT", ignore);
    let settled = false;
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      process.off("SIGINT", ignore);
      resolveExit(code);
    };
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: "inherit",
    });
    child.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        process.stderr.write(
          `wip start: command not found: ${argv[0]} (the start command is ${shown(argv)}; check PATH or run \`wip start --set -- …\`)\n`,
        );
        settle(127);
      } else {
        process.stderr.write(`wip start: cannot run ${argv[0]}: ${err.message}\n`);
        settle(126);
      }
    });
    child.on("exit", (code, signal) => {
      const number = signal ? (osConstants.signals[signal] ?? 0) : 0;
      settle(code ?? (signal ? 128 + number : 1));
    });
  });
}

/**
 * `wip start` (and bare `wip` when it qualifies): launches the start command from the project root and returns
 * the child's exit code. Errors are written to stderr and returned as their exit code.
 */
export async function startLaunch(
  rest: readonly string[],
  cwd: string,
  env: TEnv,
  tty: boolean,
): Promise<number> {
  try {
    const extras = launchExtras(rest);
    if (env[WIP_START_ENV] !== undefined) {
      throw usage(
        "this session was started by wip start (WIP_START is set): a session cannot start another one",
      );
    }
    if (!tty) {
      throw usage(
        "`wip start` needs a terminal on stdin and stdout; use `wip start --dry-run` to see the command",
      );
    }
    const root = projectFor(cwd, env);
    const vars = startVars(root, env);
    const stamp = vars.stamp;
    const argv = [...expandStart(resolveStart(root.project).template, vars), ...extras];
    const launched = recordWipBin(root.project, cwd, env);
    // The launcher's path is for wip only: it does not reach the coordinator session.
    const childEnv: Record<string, string | undefined> = { ...env, [WIP_START_ENV]: stamp };
    delete childEnv[WIP_LAUNCH_BIN_ENV];
    // WIP_BIN is always set or deleted, so a stale value from the user's shell never reaches the session.
    const bin = childWipBin(root.project, launched);
    if (bin) childEnv[WIP_BIN_ENV] = bin;
    else delete childEnv[WIP_BIN_ENV];
    return await runChild(argv, root.project, childEnv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`wip: ${message}\n`);
    return err instanceof WipError ? err.code : EXIT.DB;
  }
}

/** Whether a bare `wip` can launch here: a project is found and a start command is usable. */
export function canLaunchBare(cwd: string, env: TEnv): boolean {
  try {
    resolveStart(projectFor(cwd, env).project);
    return true;
  } catch {
    return false;
  }
}
