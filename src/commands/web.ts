import { existsSync, readFileSync, statSync } from "node:fs";
import { allow, type IArgs, parseArgs } from "../args.ts";
import { envelope, newResult } from "../context.ts";
import { findRoot, type IRoot, type TEnv } from "../env.ts";
import { EXIT, notFound, rejected, usage, WipError } from "../errors.ts";
import { fileLog, logLines, type TWebLog, tailLog, webLogPath } from "../web/log.ts";
import { clearWebPid, readWebPid, writeWebPid } from "../web/pidfile.ts";
import {
  APP,
  DEFAULT_PORT,
  type IHealth,
  type IWebServer,
  startWeb,
  type TInterfaces,
} from "../web/server.ts";
import { findCommand } from "./help.ts";

export interface IWebIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Resolves when the server must stop: Ctrl-C or SIGTERM by default. */
  stopped: () => Promise<void>;
  /** Rejects when no browser could be opened. */
  open: (url: string) => Promise<void>;
}

export interface IWebMainOptions {
  cwd?: string;
  env?: TEnv;
  io?: Partial<IWebIo>;
  interfaces?: TInterfaces;
  /** Called once the server listens (tests read its port). */
  onListen?: (web: IWebServer) => void;
  /** `process.kill` by default; `wip web stop` sends SIGTERM through it. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

function untilSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };
    process.on("SIGINT", done);
    process.on("SIGTERM", done);
  });
}

export function browserCommand(url: string, platform: string = process.platform): string[] {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["cmd", "/c", "start", "", url];
  return ["xdg-open", url];
}

export async function openBrowser(
  url: string,
  command: readonly string[] = browserCommand(url),
): Promise<void> {
  const proc = Bun.spawn([...command], { stdout: "ignore", stderr: "ignore" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${command[0]} exited with ${code}`);
}

// xdg-open can stay attached to the browser it launches: past this wait the browser counts as opened.
const OPEN_WAIT_MS = 5000;

async function openUrl(io: IWebIo, url: string, log: TWebLog): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), OPEN_WAIT_MS);
  });
  const attempt = Promise.resolve()
    .then(() => io.open(url))
    .then(
      () => null,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
  const failure = await Promise.race([attempt, waited]);
  clearTimeout(timer);
  if (failure) {
    io.err(`warning: could not open a browser (${failure}); open ${url}`);
    log("warn", `could not open a browser: ${failure}`);
  }
}

const DEFAULT_IO: IWebIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  stopped: untilSignal,
  open: openBrowser,
};

export const UNKNOWN_PROJECT = "an unknown project";

type TProbe = { kind: "wip"; health: IHealth } | { kind: "other" } | { kind: "none" };

/** What answers on 127.0.0.1:<port>: a `wip web` (with its /health), another program, or nothing. */
export async function probe(port: number, timeoutMs = 500): Promise<TProbe> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { kind: "none" };
  }
  try {
    const body = (await res.json()) as IHealth;
    if (res.ok && body?.app === APP && Number.isInteger(body.pid)) {
      // An older wip web answers /health without `project`: it is never this project's.
      const project = typeof body.project === "string" ? body.project : UNKNOWN_PROJECT;
      return { kind: "wip", health: { ...body, project } };
    }
  } catch {
    // not JSON: another program
  }
  return { kind: "other" };
}

export function portOf(value: string | undefined, env: TEnv): number {
  const raw = value ?? env.WIP_WEB_PORT ?? String(DEFAULT_PORT);
  if (!/^\d{1,5}$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
    throw usage("--port: an integer between 1 and 65535");
  }
  return Number(raw);
}

/** Vite-style address lines: `Local:` always, `LAN:` with the private IP or why there is none. */
export function urlLines(port: number, lan: string | null, local: boolean): string[] {
  const lanText = lan
    ? `http://${lan}:${port}/`
    : local
      ? "off (--local)"
      : "off (no private IPv4)";
  return [`  Local: http://localhost:${port}/`, `  LAN:   ${lanText}`];
}

function isAddrInUse(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return (
    e?.code === "EADDRINUSE" || /EADDRINUSE|address already in use|in use/i.test(e?.message ?? "")
  );
}

const inUse = (port: number): WipError =>
  rejected(`port ${port} is in use by another program; choose another one with --port`);

const localUrl = (port: number): string => `http://localhost:${port}/`;

/** Exit code of `wip web status` when nothing answers on the port. */
export const NOT_RUNNING = EXIT.FINDINGS;
const STATUS_TIMEOUT_MS = 2000;

type TStatusState = "running" | "not-running" | "other-project" | "other-program";

/** `--port`, else `WIP_WEB_PORT`, else the port in `.wip/web.pid`, else the default. */
function targetPort(args: IArgs, env: TEnv, root: IRoot): number {
  if (args.opts.port !== undefined || env.WIP_WEB_PORT !== undefined) {
    return portOf(args.opts.port, env);
  }
  return readWebPid(root)?.port ?? DEFAULT_PORT;
}

const STOP_WAIT_MS = 10000;
const STOP_POLL_MS = 100;

async function stop(args: IArgs, options: IWebMainOptions, io: IWebIo): Promise<number> {
  if (args.pos.length > 1) {
    throw usage(`wip web stop takes no arguments: ${args.pos.slice(1).join(" ")}`);
  }
  const env = options.env ?? process.env;
  const root = findRoot(options.cwd ?? process.cwd(), env);
  const port = targetPort(args, env, root);
  const found = await probe(port, STATUS_TIMEOUT_MS);
  const result = newResult();
  let state: string;
  let line: string;
  if (found.kind === "wip" && found.health.project === root.project) {
    const pid = found.health.pid;
    (options.kill ?? process.kill)(pid, "SIGTERM");
    const deadline = Date.now() + STOP_WAIT_MS;
    while ((await probe(port, STATUS_TIMEOUT_MS)).kind !== "none" && Date.now() < deadline) {
      await Bun.sleep(STOP_POLL_MS);
    }
    if ((await probe(port, STATUS_TIMEOUT_MS)).kind !== "none") {
      throw rejected(
        `wip web (PID ${pid}) still answers on port ${port} ${STOP_WAIT_MS / 1000} s after SIGTERM; stop it by hand`,
      );
    }
    clearWebPid(root, pid);
    state = "stopped";
    line = `wip web stopped for ${root.project} (PID ${pid}, port ${port})`;
    result.data = { state, port, project: root.project, pid };
  } else {
    result.ok = false;
    if (found.kind === "wip") {
      state = "other-project";
      result.code = EXIT.REJECTED;
      line = `port ${port} serves wip web for ${found.health.project}: not stopped`;
    } else if (found.kind === "other") {
      state = "other-program";
      result.code = EXIT.REJECTED;
      line = `port ${port} is in use by another program: not stopped`;
    } else {
      state = "not-running";
      result.code = NOT_RUNNING;
      const stale = readWebPid(root) !== null;
      if (stale) clearWebPid(root);
      line = `wip web is not running on port ${port}${stale ? " (removed a stale .wip/web.pid)" : ""}`;
    }
    result.data = { state, port, project: root.project };
  }
  result.message = line;
  if (args.flags.has("json")) io.out(JSON.stringify(envelope(result)));
  else io.out(line);
  return result.code;
}

async function status(args: IArgs, options: IWebMainOptions, io: IWebIo): Promise<number> {
  if (args.pos.length > 1) {
    throw usage(`wip web status takes no arguments: ${args.pos.slice(1).join(" ")}`);
  }
  const env = options.env ?? process.env;
  const root = findRoot(options.cwd ?? process.cwd(), env);
  const port = targetPort(args, env, root);
  const found = await probe(port, STATUS_TIMEOUT_MS);
  const result = newResult();
  let state: TStatusState;
  const lines: string[] = [];
  if (found.kind === "wip" && found.health.project === root.project) {
    state = "running";
    lines.push(`wip web is running for ${root.project} (PID ${found.health.pid})`);
    lines.push(...urlLines(port, found.health.lan, found.health.local));
    result.data = {
      state,
      port,
      project: root.project,
      pid: found.health.pid,
      url: localUrl(port),
      lan_url: found.health.lan ? `http://${found.health.lan}:${port}/` : null,
      version: found.health.version,
    };
  } else {
    if (found.kind === "wip") {
      state = "other-project";
      result.code = EXIT.REJECTED;
      lines.push(`port ${port} serves wip web for ${found.health.project}`);
    } else if (found.kind === "other") {
      state = "other-program";
      result.code = EXIT.REJECTED;
      lines.push(`port ${port} is in use by another program`);
    } else {
      state = "not-running";
      result.code = NOT_RUNNING;
      lines.push(`wip web is not running on port ${port}`);
    }
    result.ok = false;
    result.data = {
      state,
      port,
      project: root.project,
      other_project: found.kind === "wip" ? found.health.project : null,
    };
  }
  result.message = lines[0] ?? null;
  if (args.flags.has("json")) io.out(JSON.stringify(envelope(result)));
  else for (const line of lines) io.out(line);
  return result.code;
}

async function serve(
  argv: readonly string[],
  options: IWebMainOptions,
  io: IWebIo,
): Promise<number> {
  const spec = findCommand("web");
  const args = parseArgs(
    argv.map((arg) => (arg === "-n" ? "--lines" : arg)),
    spec?.flags ?? [],
  );
  allow(args, [...(spec?.options ?? []), ...(spec?.flags ?? [])]);
  const first = args.pos[0];
  const sub = first === "status" || first === "log" || first === "stop" ? first : "serve";
  const extra = [...Object.keys(args.opts), ...args.flags].filter(
    (key) => key !== "json" && !(SUB_OPTIONS[sub] as readonly string[]).includes(key),
  );
  if (extra.length > 0) {
    const name = sub === "serve" ? "wip web" : `wip web ${sub}`;
    throw usage(`${name} does not take --${extra.join(", --")}`);
  }
  if (sub === "status") return status(args, options, io);
  if (sub === "log") return showLog(args, options, io);
  if (sub === "stop") return stop(args, options, io);
  if (args.pos.length > 0) throw usage(`wip web takes no arguments: ${args.pos.join(" ")}`);
  const env = options.env ?? process.env;
  const port = portOf(args.opts.port, env);
  const local = args.flags.has("local");
  const root = findRoot(options.cwd ?? process.cwd(), env);
  const log = fileLog(webLogPath(root));
  const found = await probe(port);
  if (found.kind === "wip") {
    if (found.health.project !== root.project) {
      const message = `port ${port} serves wip web for ${found.health.project}`;
      log("error", message);
      throw rejected(`${message}; choose another one with --port`);
    }
    io.out(`wip web is already running for ${root.project} (PID ${found.health.pid})`);
    for (const line of urlLines(port, found.health.lan, found.health.local)) io.out(line);
    if (args.flags.has("open")) await openUrl(io, localUrl(port), log);
    return EXIT.OK;
  }
  let web: IWebServer;
  try {
    if (found.kind === "other") throw inUse(port);
    web = startWeb({ port, root, local, interfaces: options.interfaces, log });
  } catch (err) {
    const failure = err instanceof WipError || !isAddrInUse(err) ? err : inUse(port);
    log("error", failure instanceof Error ? failure.message : String(failure));
    throw failure;
  }
  log(
    "info",
    `start · pid ${process.pid} · Local ${web.url} · LAN ${web.lanUrl ?? (local ? "off (--local)" : "off")}`,
  );
  io.out(`wip web · ${root.project}`);
  for (const line of urlLines(web.port, web.lan, local)) io.out(line);
  io.out(`Read-only. Log: ${webLogPath(root)}. Ctrl-C stops it.`);
  writeWebPid(root, web.port);
  const exited = (): void => clearWebPid(root, process.pid);
  process.once("exit", exited);
  options.onListen?.(web);
  if (args.flags.has("open")) void openUrl(io, web.url, log);
  await io.stopped();
  web.stop();
  process.off("exit", exited);
  clearWebPid(root, process.pid);
  log("info", "stop");
  return EXIT.OK;
}

const SUB_OPTIONS = {
  serve: ["port", "open", "local"],
  status: ["port"],
  stop: ["port"],
  log: ["lines", "follow"],
} as const satisfies Record<string, readonly string[]>;

const DEFAULT_LOG_LINES = 50;
const FOLLOW_POLL_MS = 500;

function linesOf(value: string | undefined): number {
  if (value === undefined) return DEFAULT_LOG_LINES;
  if (!/^\d{1,6}$/.test(value) || Number(value) < 1) throw usage("-n: a positive integer");
  return Number(value);
}

async function showLog(args: IArgs, options: IWebMainOptions, io: IWebIo): Promise<number> {
  if (args.pos.length > 1) {
    throw usage(`wip web log takes no arguments: ${args.pos.slice(1).join(" ")}`);
  }
  const count = linesOf(args.opts.lines);
  const follow = args.flags.has("follow");
  const json = args.flags.has("json");
  if (follow && json) throw usage("--follow prints text: drop --json");
  const root = findRoot(options.cwd ?? process.cwd(), options.env ?? process.env);
  const path = webLogPath(root);
  if (!existsSync(path)) {
    throw notFound(`no wip web log at ${path}: \`wip web\` writes it when it starts`);
  }
  const lines = tailLog(path, count);
  if (json) {
    io.out(JSON.stringify(envelope({ ...newResult(), data: { path, lines } })));
    return EXIT.OK;
  }
  for (const line of lines) io.out(line);
  if (!follow) return EXIT.OK;
  let stopped = false;
  const stop = io.stopped().then(() => {
    stopped = true;
  });
  let offset = statSync(path).size;
  while (!stopped) {
    await Promise.race([stop, Bun.sleep(FOLLOW_POLL_MS)]);
    if (stopped || !existsSync(path)) continue;
    const bytes = readFileSync(path);
    if (bytes.length < offset) offset = 0;
    const end = bytes.lastIndexOf(0x0a);
    if (end < offset) continue;
    for (const line of logLines(bytes.subarray(offset, end + 1).toString("utf8"))) io.out(line);
    offset = end + 1;
  }
  return EXIT.OK;
}

/** `wip web`: serves in the foreground until Ctrl-C, so it runs outside the synchronous `run()`. */
export async function webMain(
  argv: readonly string[],
  options: IWebMainOptions = {},
): Promise<number> {
  const io: IWebIo = { ...DEFAULT_IO, ...options.io };
  try {
    return await serve(argv, options, io);
  } catch (err) {
    const code = err instanceof WipError ? err.code : EXIT.DB;
    const message = err instanceof Error ? err.message : String(err);
    if (argv.includes("--json")) {
      io.out(
        JSON.stringify(envelope({ ...newResult(), ok: false, code, message, data: { code } })),
      );
    } else {
      io.err(`wip: ${message}`);
    }
    return code;
  }
}
