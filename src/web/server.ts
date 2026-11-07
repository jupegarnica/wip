import { readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type NetworkInterfaceInfo, networkInterfaces } from "node:os";
import pkg from "../../package.json" with { type: "json" };
import { itemView } from "../commands/show.ts";
import type { TDatabase } from "../db.ts";
import { MARKDOWN_LIB, WEB } from "../embedded/web.ts";
import type { IRoot } from "../env.ts";
import { FLOW_NAME_RE } from "../flow/parse.ts";
import { DEFAULT_ID_RE, type IFlowSet, loadFlows } from "../flow/registry.ts";
import { findItem } from "../items.ts";
import { ARTIFACT_MAX_BYTES, artifactFile, itemDir, listArtifacts } from "./artifacts.ts";
import { historyData, parseHistoryQuery } from "./history.ts";
import type { TWebLog } from "./log.ts";
import { boardData, itemLinks, migrateIfBehind, openReadOnly } from "./state.ts";

// A read-only kanban on 127.0.0.1 and, unless `local`, on the machine's private LAN IPv4 too. Stateless: each /api
// request opens the database read-only, reads and closes it, so a concurrent `wip phase` is never blocked.

export const APP = "wip-web";
export const DEFAULT_PORT = 33333;
/** `wip web` without `--port` tries this many ports from the first one before giving up. */
export const PORT_TRIES = 20;

export type TInterfaces = Record<string, NetworkInterfaceInfo[] | undefined>;

export interface IWebOptions {
  port: number;
  root: IRoot;
  /** Loopback only: no LAN listener, and the Host check accepts only localhost and 127.0.0.1. */
  local?: boolean;
  /** `os.networkInterfaces()` by default. */
  interfaces?: TInterfaces;
  /** Receives every response with status ≥ 400 and every error behind a 503. */
  log?: TWebLog;
}

export interface IWebServer {
  server: Server;
  lanServer: Server | null;
  port: number;
  url: string;
  lan: string | null;
  lanUrl: string | null;
  /** Stops listening and drops open connections; resolves once both servers are closed. */
  stop: () => Promise<void>;
}

export interface IHealth {
  app: string;
  pid: number;
  port: number;
  project: string;
  version: string;
  lan: string | null;
  local: boolean;
}

/** Private-range rank of an IPv4 (0: 192.168/16, 1: 10/8, 2: 172.16/12), or null when it is not private. */
export function privateRank(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m || m.slice(1).some((o) => Number(o) > 255)) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 192 && b === 168) return 0;
  if (a === 10) return 1;
  if (a === 172 && b >= 16 && b <= 31) return 2;
  return null;
}

/** The machine's non-internal private IPv4s, preferred first; ties keep the OS order. */
export function privateIPv4s(ifaces: TInterfaces = networkInterfaces()): string[] {
  const found: { ip: string; rank: number; order: number }[] = [];
  for (const list of Object.values(ifaces)) {
    for (const info of list ?? []) {
      const family = info.family as unknown;
      if (info.internal || (family !== "IPv4" && family !== 4)) continue;
      const rank = privateRank(info.address);
      if (rank !== null && !found.some((f) => f.ip === info.address)) {
        found.push({ ip: info.address, rank, order: found.length });
      }
    }
  }
  return found.sort((x, y) => x.rank - y.rank || x.order - y.order).map((f) => f.ip);
}

/** Host header values the server answers (DNS rebinding): loopback names and the given IPs, with the port. */
export function allowedHosts(port: number, ips: readonly string[] = []): Set<string> {
  return new Set(["localhost", "127.0.0.1", ...ips].map((h) => `${h}:${port}`));
}

export const PAGE_CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'";
/** An artifact is shown as text, never run: no scripts, no subresources, its own sandboxed origin. */
export const ARTIFACT_CSP = "default-src 'none'; sandbox; frame-ancestors 'none'";

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": PAGE_CSP,
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};
const TEXT = "text/plain; charset=utf-8";
const JSON_TYPE = "application/json; charset=utf-8";
const TYPES: Readonly<Record<string, string>> = {
  css: "text/css; charset=utf-8",
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
};
const LIB_PREFIX = "/lib/garndev-markdown/";

function typeOf(path: string): string {
  return TYPES[path.slice(path.lastIndexOf(".") + 1)] ?? TEXT;
}

function respond(
  body: string,
  status: number,
  type: string,
  extra: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: { ...SECURITY_HEADERS, "Content-Type": type, ...extra },
  });
}

const json = (value: unknown, status = 200): Response =>
  respond(JSON.stringify(value), status, JSON_TYPE);
const notFoundRes = (): Response => respond("not found", 404, TEXT);

/** Each page file by URL: `/index.html` is also `/`; `view.html` is only served under /view/. */
const STATIC: ReadonlyMap<string, string> = new Map([
  ...Object.keys(WEB)
    .filter((k) => k !== "view.html")
    .map((k): [string, string] => [`/${k}`, k]),
  ["/", "index.html"],
]);

function libFile(path: string): string | null {
  if (!path.startsWith(LIB_PREFIX)) return null;
  const key = path.slice(LIB_PREFIX.length);
  const name = key === "tokens.css" ? key : `dist/${key}`;
  return Object.hasOwn(MARKDOWN_LIB, name) ? name : null;
}

function segment(s: string | undefined): string | null {
  if (s === undefined) return null;
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

interface IItemRef {
  flow: string;
  id: string;
}

function itemRef(rawFlow: string | undefined, rawId: string | undefined): IItemRef | null {
  const flow = segment(rawFlow);
  const id = segment(rawId);
  if (flow === null || id === null || !FLOW_NAME_RE.test(flow) || !DEFAULT_ID_RE.test(id)) {
    return null;
  }
  return { flow, id };
}

export async function startWeb(options: IWebOptions): Promise<IWebServer> {
  const { root } = options;
  migrateIfBehind(root.db); // a database one build behind is migrated here; one ahead still fails below
  openReadOnly(root.db)?.close(); // fail fast on a schema this build does not read

  function read<T>(fn: (db: TDatabase | null, flows: IFlowSet) => T): T {
    const db = openReadOnly(root.db);
    try {
      return fn(db, loadFlows(root, db));
    } finally {
      db?.close();
    }
  }

  const dbError = (err: unknown): Response => {
    const message = err instanceof Error ? err.message : String(err);
    options.log?.("error", message);
    return json({ error: message }, 503);
  };

  function exists(db: TDatabase | null, ref: IItemRef): boolean {
    return findItem(db, ref.id)?.flow === ref.flow;
  }

  function artifactPath(ref: IItemRef, rawName: string | undefined): string | null {
    const name = segment(rawName);
    if (name === null) return null;
    const found = read((db) => exists(db, ref));
    const dir = found ? itemDir(root, ref.flow, ref.id) : null;
    return dir ? artifactFile(dir, name) : null;
  }

  function item(parts: string[]): Response {
    const ref = itemRef(parts[0], parts[1]);
    if (!ref) return notFoundRes();
    try {
      if (parts.length === 2) {
        const data = read((db, flows) => {
          if (!db || !exists(db, ref)) return null;
          const view = itemView(db, flows, ref.id);
          return {
            ...view,
            links: itemLinks(
              flows.entries.get(ref.flow)?.flow ?? null,
              ref.id,
              view.item.fields as Record<string, unknown>,
            ),
            artifacts: listArtifacts(root, ref.flow, ref.id),
          };
        });
        return data ? json(data) : notFoundRes();
      }
      if (parts.length === 4 && parts[2] === "artifact") {
        const file = artifactPath(ref, parts[3]);
        if (!file) return notFoundRes();
        if (statSync(file).size > ARTIFACT_MAX_BYTES) {
          return respond("artifact larger than 2 MB", 413, TEXT);
        }
        return respond(readFileSync(file, "utf8"), 200, TEXT, {
          "Content-Security-Policy": ARTIFACT_CSP,
          "Content-Disposition": "inline",
        });
      }
    } catch (err) {
      return dbError(err);
    }
    return notFoundRes();
  }

  /** /view/item/<flow>/<ID>/artifact/<name>: the static page, only where /api/… serves the same artifact. */
  function view(parts: string[]): Response {
    if (parts.length !== 5 || parts[0] !== "item" || parts[3] !== "artifact") return notFoundRes();
    const ref = itemRef(parts[1], parts[2]);
    if (!ref) return notFoundRes();
    try {
      if (!artifactPath(ref, parts[4])) return notFoundRes();
    } catch (err) {
      return dbError(err);
    }
    return respond(WEB["view.html"] as string, 200, TYPES.html as string);
  }

  const ips = options.local ? [] : privateIPv4s(options.interfaces);
  const lan = ips[0] ?? null;
  let hosts = new Set<string>();
  let port = options.port;

  function handle(req: Request): Response {
    if (!hosts.has(req.headers.get("host") ?? "")) return respond("forbidden", 403, TEXT);
    if (req.method !== "GET") return respond("method not allowed", 405, TEXT);
    const url = new URL(req.url);
    const path = url.pathname;
    if (path.startsWith("/api/item/")) return item(path.slice("/api/item/".length).split("/"));
    if (path.startsWith("/view/")) return view(path.slice("/view/".length).split("/"));
    const lib = libFile(path);
    if (lib) return respond(MARKDOWN_LIB[lib] as string, 200, typeOf(lib));
    const page = STATIC.get(path);
    if (page) return respond(WEB[page] as string, 200, typeOf(page));
    switch (path) {
      case "/api/kanban":
        try {
          return json(read((db, flows) => boardData(db, flows)));
        } catch (err) {
          return dbError(err);
        }
      case "/api/history": {
        const query = parseHistoryQuery(url.searchParams);
        if (typeof query === "string") return json({ error: query }, 400);
        try {
          return json(read((db, flows) => historyData(db, flows, query)));
        } catch (err) {
          return dbError(err);
        }
      }
      case "/health": {
        const health: IHealth = {
          app: APP,
          pid: process.pid,
          port,
          project: root.project,
          version: pkg.version,
          lan,
          local: Boolean(options.local),
        };
        return json(health);
      }
      default:
        return notFoundRes();
    }
  }

  function logged(req: Request): Response {
    let res: Response;
    try {
      res = handle(req);
    } catch (err) {
      options.log?.("error", `${req.method} ${new URL(req.url).pathname}: ${String(err)}`);
      return respond("internal error", 500, TEXT);
    }
    if (res.status >= 400) {
      const host = res.status === 403 ? ` (host ${req.headers.get("host") ?? "none"})` : "";
      options.log?.(
        res.status >= 500 ? "error" : "warn",
        `${res.status} ${req.method} ${new URL(req.url).pathname}${host}`,
      );
    }
    return res;
  }

  const server = await listen("127.0.0.1", options.port, logged);
  port = (server.address() as AddressInfo).port;
  hosts = allowedHosts(port, ips);
  let lanServer: Server | null = null;
  if (lan) {
    try {
      lanServer = await listen(lan, port, logged);
    } catch (err) {
      await close(server);
      throw err;
    }
  }
  return {
    server,
    lanServer,
    port,
    url: `http://localhost:${port}/`,
    lan,
    lanUrl: lan ? `http://${lan}:${port}/` : null,
    stop: async () => {
      await Promise.all([close(server), lanServer ? close(lanServer) : undefined]);
    },
  };
}

type TFetch = (req: Request) => Response;

/** Binds `hostname:port` (0 picks a free port); a port in use rejects with `EADDRINUSE`. */
function listen(hostname: string, port: number, fetch: TFetch): Promise<Server> {
  const server = createServer((req, res) => reply(req, res, fetch));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/** The bridge from `node:http` to the fetch-style handler: GET only and string bodies, so the body is never read. */
function reply(req: IncomingMessage, res: ServerResponse, fetch: TFetch): void {
  let response: Response;
  try {
    const headers = new Headers();
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      headers.append(req.rawHeaders[i] as string, req.rawHeaders[i + 1] as string);
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
    response = fetch(new Request(url.href, { method: req.method ?? "GET", headers }));
  } catch {
    response = respond("bad request", 400, TEXT);
  }
  res.writeHead(response.status, Object.fromEntries(response.headers));
  response.text().then(
    (body) => res.end(body),
    () => res.end(),
  );
}
