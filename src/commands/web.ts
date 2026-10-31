import { existsSync, readFileSync, statSync } from "node:fs";
import { connect } from "node:net";
import { allow, type IArgs, parseArgs } from "../args.ts";
import { envelope, newResult } from "../context.ts";
import { findRoot, type IRoot, type TEnv } from "../env.ts";
import { EXIT, notFound, rejected, usage, WipError } from "../errors.ts";
import { fileLog, logLines, type TWebLog, tailLog, webLogPath } from "../web/log.ts";
import {
  clearWebServer,
  type IWebEntry,
  readWebServers,
  removeWebEntry,
  writeWebServer,
} from "../web/pidfile.ts";
import {
  APP,
  DEFAULT_PORT,
  type IHealth,
  type IWebServer,
  PORT_TRIES,
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
  /** How `status`, `stop` and `wip web` check the registered servers; the real checks by default. */
  live?: Partial<ILiveDeps>;
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

export type TProbe = { kind: "wip"; health: IHealth } | { kind: "other" } | { kind: "none" };

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
  return [`  Local: ${localUrl(port)}`, `  LAN:   ${lanText(port, lan, local)}`];
}

function lanText(port: number, lan: string | null, local: boolean): string {
  if (lan) return `http://${lan}:${port}/`;
  return local ? "off (--local)" : "off (no private IPv4)";
}

const ACCEPT_TIMEOUT_MS = 300;

/** Whether something accepts a TCP connection on host:port: whether the port is free, never whose it is. */
export function accepts(
  host: string,
  port: number,
  timeoutMs = ACCEPT_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (value: boolean): void => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

// Bun binds 127.0.0.1:<port> even while another program holds [::1]:<port>, and `localhost` then reaches that
// program: a port is free only when neither loopback accepts.
export async function portInUse(port: number): Promise<boolean> {
  const [v4, v6] = await Promise.all([accepts("127.0.0.1", port), accepts("::1", port)]);
  return v4 || v6;
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

export type TServerState = "running" | "unresponsive";

export interface ILiveServer extends IWebEntry {
  state: TServerState;
  health: IHealth | null;
}

export interface ILiveDeps {
  probe: (port: number) => Promise<TProbe>;
  isAlive: (pid: number) => boolean;
  accepts: (port: number) => Promise<boolean>;
}

/** `EPERM` is a live process of another user: alive, never signalled without a matching /health. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string })?.code === "EPERM";
  }
}

export const LIVE_DEPS: ILiveDeps = {
  probe: (port) => probe(port, STATUS_TIMEOUT_MS),
  isAlive: pidAlive,
  accepts: (port) => accepts("127.0.0.1", port),
};

const liveDeps = (options: IWebMainOptions): ILiveDeps => ({ ...LIVE_DEPS, ...options.live });

/**
 * This project's registered servers, each checked on its own port only. A dead PID, or a port whose /health names
 * another PID, project or program, is removed from the registry; one that accepts connections but does not answer
 * stays as `unresponsive`.
 */
export async function liveWebServers(
  root: IRoot,
  deps: ILiveDeps = LIVE_DEPS,
): Promise<{ servers: ILiveServer[]; removed: number }> {
  const servers: ILiveServer[] = [];
  let removed = 0;
  const drop = (entry: IWebEntry): void => {
    removeWebEntry(root, entry);
    removed++;
  };
  for (const entry of readWebServers(root)) {
    if (!deps.isAlive(entry.pid)) {
      drop(entry);
      continue;
    }
    const found = await deps.probe(entry.port);
    if (found.kind === "wip") {
      if (found.health.project === root.project && found.health.pid === entry.pid) {
        servers.push({ ...entry, state: "running", health: found.health });
      } else drop(entry);
    } else if (found.kind === "none" && (await deps.accepts(entry.port))) {
      servers.push({ ...entry, state: "unresponsive", health: null });
    } else drop(entry);
  }
  return { servers, removed };
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

const staleEntries = (n: number): string => `${n} stale ${n === 1 ? "entry" : "entries"}`;

const removedNote = (removed: number): string =>
  removed > 0 ? ` (removed ${staleEntries(removed)})` : "";

function serverLine(s: ILiveServer): string {
  const head = `  ${s.port}  PID ${s.pid}`;
  if (!s.health) return `${head}  not answering`;
  return `${head}  Local: ${localUrl(s.port)}  LAN: ${lanText(s.port, s.health.lan, s.health.local)}`;
}

const lanUrlOf = (s: ILiveServer): string | null =>
  s.health?.lan ? `http://${s.health.lan}:${s.port}/` : null;

function serverView(s: ILiveServer): Record<string, unknown> {
  return {
    port: s.port,
    pid: s.pid,
    url: localUrl(s.port),
    lan_url: lanUrlOf(s),
    version: s.health?.version ?? s.version,
    started_at: s.started_at || null,
    state: s.state,
  };
}

const STOP_WAIT_MS = 10000;
const STOP_POLL_MS = 100;

async function stop(args: IArgs, options: IWebMainOptions, io: IWebIo): Promise<number> {
  if (args.pos.length > 1) {
    throw usage(`wip web stop takes no arguments: ${args.pos.slice(1).join(" ")}`);
  }
  const env = options.env ?? process.env;
  const only = args.opts.port === undefined ? null : portOf(args.opts.port, env);
  const root = findRoot(options.cwd ?? process.cwd(), env);
  const deps = liveDeps(options);
  const live = await liveWebServers(root, deps);
  let removed = live.removed;
  const stopped: { port: number; pid: number }[] = [];
  const lines: string[] = [];
  let stuck = false;
  for (const s of live.servers) {
    if (only !== null && s.port !== only) continue;
    if (s.state === "unresponsive") {
      removeWebEntry(root, s);
      removed++;
      continue;
    }
    (options.kill ?? process.kill)(s.pid, "SIGTERM");
    const deadline = Date.now() + STOP_WAIT_MS;
    while ((await deps.probe(s.port)).kind !== "none" && Date.now() < deadline) {
      await Bun.sleep(STOP_POLL_MS);
    }
    if ((await deps.probe(s.port)).kind !== "none") {
      stuck = true;
      lines.push(
        `wip web (PID ${s.pid}) still answers on port ${s.port} ${STOP_WAIT_MS / 1000} s after SIGTERM; stop it by hand`,
      );
      continue;
    }
    removeWebEntry(root, s);
    stopped.push({ port: s.port, pid: s.pid });
    lines.push(`wip web stopped for ${root.project} (PID ${s.pid}, port ${s.port})`);
  }
  const result = newResult();
  let state = "stopped";
  if (stuck) {
    state = "still-running";
    result.ok = false;
    result.code = EXIT.REJECTED;
  } else if (stopped.length === 0) {
    state = "not-running";
    result.ok = false;
    result.code = NOT_RUNNING;
    const where = only === null ? "" : ` on port ${only}`;
    lines.push(`wip web is not running for ${root.project}${where}${removedNote(removed)}`);
  } else if (removed > 0) {
    lines.push(`removed ${staleEntries(removed)}`);
  }
  result.data = {
    state,
    project: root.project,
    port: stopped[0]?.port ?? null,
    pid: stopped[0]?.pid ?? null,
    stopped,
    removed,
  };
  result.message = lines[0] ?? null;
  if (args.flags.has("json")) io.out(JSON.stringify(envelope(result)));
  else for (const line of lines) io.out(line);
  return result.code;
}

async function status(args: IArgs, options: IWebMainOptions, io: IWebIo): Promise<number> {
  if (args.pos.length > 1) {
    throw usage(`wip web status takes no arguments: ${args.pos.slice(1).join(" ")}`);
  }
  const root = findRoot(options.cwd ?? process.cwd(), options.env ?? process.env);
  const { servers, removed } = await liveWebServers(root, liveDeps(options));
  const running = servers.filter((s) => s.state === "running");
  const first = running[0] ?? null;
  const result = newResult();
  const lines: string[] = [];
  if (first) {
    lines.push(
      `wip web is running for ${root.project}: ${plural(running.length, "server")}${removedNote(removed)}`,
    );
  } else {
    result.ok = false;
    result.code = NOT_RUNNING;
    lines.push(`wip web is not running for ${root.project}${removedNote(removed)}`);
  }
  lines.push(...servers.map(serverLine));
  result.data = {
    state: first ? "running" : "not-running",
    project: root.project,
    port: first?.port ?? null,
    pid: first?.pid ?? null,
    url: first ? localUrl(first.port) : null,
    lan_url: first ? lanUrlOf(first) : null,
    servers: servers.map(serverView),
    removed,
  };
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
  const explicit = args.opts.port !== undefined;
  const base = portOf(args.opts.port, env);
  const local = args.flags.has("local");
  const root = findRoot(options.cwd ?? process.cwd(), env);
  const log = fileLog(webLogPath(root));
  const alreadyRunning = async (health: IHealth, port: number): Promise<number> => {
    io.out(`wip web is already running for ${root.project} (PID ${health.pid})`);
    for (const line of urlLines(port, health.lan, health.local)) io.out(line);
    if (args.flags.has("open")) await openUrl(io, localUrl(port), log);
    return EXIT.OK;
  };
  const start = (port: number): IWebServer =>
    startWeb({ port, root, local, interfaces: options.interfaces, log });
  let web: IWebServer;
  if (explicit) {
    const found = await probe(base);
    if (found.kind === "wip") {
      if (found.health.project === root.project) return alreadyRunning(found.health, base);
      const message = `port ${base} serves wip web for ${found.health.project}`;
      log("error", message);
      throw rejected(`${message}; choose another one with --port`);
    }
    try {
      if (found.kind === "other" || (await portInUse(base))) throw inUse(base);
      web = start(base);
    } catch (err) {
      const failure = err instanceof WipError || !isAddrInUse(err) ? err : inUse(base);
      log("error", failure instanceof Error ? failure.message : String(failure));
      throw failure;
    }
  } else {
    const running = (await liveWebServers(root, liveDeps(options))).servers.find(
      (s) => s.state === "running",
    );
    if (running?.health) return alreadyRunning(running.health, running.port);
    try {
      web = await startOnFirstFree(base, start, log);
    } catch (err) {
      log("error", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
  log(
    "info",
    `start · pid ${process.pid} · Local ${web.url} · LAN ${web.lanUrl ?? (local ? "off (--local)" : "off")}`,
  );
  io.out(`wip web · ${root.project}`);
  for (const line of urlLines(web.port, web.lan, local)) io.out(line);
  io.out(`Read-only. Log: ${webLogPath(root)}. Ctrl-C stops it.`);
  writeWebServer(root, web.port);
  const exited = (): void => clearWebServer(root, web.port, process.pid);
  process.once("exit", exited);
  options.onListen?.(web);
  if (args.flags.has("open")) void openUrl(io, web.url, log);
  await io.stopped();
  web.stop();
  process.off("exit", exited);
  clearWebServer(root, web.port, process.pid);
  log("info", "stop");
  return EXIT.OK;
}

const MAX_PORT = 65535;

/** From `base`, the first port nothing accepts on and that binds; each one skipped is a line in the log. */
async function startOnFirstFree(
  base: number,
  start: (port: number) => IWebServer,
  log: TWebLog,
): Promise<IWebServer> {
  const last = Math.min(base + PORT_TRIES - 1, MAX_PORT);
  for (let port = base; port <= last; port++) {
    if (!(await portInUse(port))) {
      try {
        return start(port);
      } catch (err) {
        if (!isAddrInUse(err)) throw err;
      }
    }
    log("info", port < last ? `port ${port} in use, trying ${port + 1}` : `port ${port} in use`);
  }
  throw rejected(`no free port from ${base} to ${last}; choose one with --port`);
}

const SUB_OPTIONS = {
  serve: ["port", "open", "local"],
  status: [],
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
