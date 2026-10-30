import { allow, parseArgs } from "../args.ts";
import { findRoot, type TEnv } from "../env.ts";
import { EXIT, rejected, usage, WipError } from "../errors.ts";
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
  open: (url: string) => void;
}

export interface IWebMainOptions {
  cwd?: string;
  env?: TEnv;
  io?: Partial<IWebIo>;
  interfaces?: TInterfaces;
  /** Called once the server listens (tests read its port). */
  onListen?: (web: IWebServer) => void;
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

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // no launcher: the URL is already printed
  }
}

const DEFAULT_IO: IWebIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  stopped: untilSignal,
  open: openBrowser,
};

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
      return { kind: "wip", health: body };
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

async function serve(
  argv: readonly string[],
  options: IWebMainOptions,
  io: IWebIo,
): Promise<number> {
  const spec = findCommand("web");
  const args = parseArgs(argv, spec?.flags ?? []);
  allow(args, [...(spec?.options ?? []), ...(spec?.flags ?? [])]);
  if (args.pos.length > 0) throw usage(`wip web takes no arguments: ${args.pos.join(" ")}`);
  const env = options.env ?? process.env;
  const port = portOf(args.opts.port, env);
  const local = args.flags.has("local");
  const root = findRoot(options.cwd ?? process.cwd(), env);
  const found = await probe(port);
  if (found.kind === "wip") {
    if (found.health.project !== root.project) {
      throw rejected(
        `port ${port} serves wip web for ${found.health.project}; choose another one with --port`,
      );
    }
    io.out(`wip web is already running for ${root.project} (PID ${found.health.pid})`);
    for (const line of urlLines(port, found.health.lan, found.health.local)) io.out(line);
    if (args.flags.has("open")) io.open(`http://localhost:${port}/`);
    return EXIT.OK;
  }
  if (found.kind === "other") throw inUse(port);
  let web: IWebServer;
  try {
    web = startWeb({ port, root, local, interfaces: options.interfaces });
  } catch (err) {
    if (err instanceof WipError) throw err;
    if (isAddrInUse(err)) throw inUse(port);
    throw err;
  }
  io.out(`wip web · ${root.project}`);
  for (const line of urlLines(web.port, web.lan, local)) io.out(line);
  io.out("Read-only. Ctrl-C stops it.");
  if (args.flags.has("open")) io.open(web.lanUrl ?? web.url);
  options.onListen?.(web);
  await io.stopped();
  web.stop();
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
    io.err(`wip: ${err instanceof Error ? err.message : String(err)}`);
    return code;
  }
}
