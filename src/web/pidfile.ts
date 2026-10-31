import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { iso } from "../clock.ts";
import type { IRoot } from "../env.ts";

// One file per server, `.wip/web/<port>.json`: each process writes and removes only its own, so two servers of the
// same project never race on a shared file.

export interface IWebEntry {
  pid: number;
  port: number;
  project: string;
  /** ISO 8601 UTC. */
  started_at: string;
  version: string | null;
  /** Read from the `.wip/web.pid` an older build wrote; nothing writes it any more. */
  legacy: boolean;
}

export function webServersDir(root: IRoot): string {
  return join(root.wip, "web");
}

export function webServerPath(root: IRoot, port: number): string {
  return join(webServersDir(root), `${port}.json`);
}

export function legacyWebPidPath(root: IRoot): string {
  return join(root.wip, "web.pid");
}

export function writeWebServer(root: IRoot, port: number): IWebEntry {
  const entry = {
    pid: process.pid,
    port,
    project: root.project,
    started_at: iso(),
    version: pkg.version,
  };
  mkdirSync(webServersDir(root), { recursive: true });
  writeFileSync(webServerPath(root, port), `${JSON.stringify(entry)}\n`);
  return { ...entry, legacy: false };
}

function parseEntry(path: string, legacy: boolean): IWebEntry | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<IWebEntry>;
    if (!Number.isInteger(raw?.pid) || !Number.isInteger(raw?.port)) return null;
    return {
      pid: raw.pid as number,
      port: raw.port as number,
      project: typeof raw.project === "string" ? raw.project : "",
      started_at: typeof raw.started_at === "string" ? raw.started_at : "",
      version: typeof raw.version === "string" ? raw.version : null,
      legacy,
    };
  } catch {
    return null;
  }
}

/** Every entry that parses, by port; the legacy `.wip/web.pid` only when no file of its own names that port. */
export function readWebServers(root: IRoot): IWebEntry[] {
  let names: string[] = [];
  try {
    names = readdirSync(webServersDir(root));
  } catch {
    names = [];
  }
  const entries: IWebEntry[] = [];
  for (const name of names) {
    const m = /^(\d{1,5})\.json$/.exec(name);
    if (!m) continue;
    const entry = parseEntry(join(webServersDir(root), name), false);
    if (entry && entry.port === Number(m[1])) entries.push(entry);
  }
  const legacy = parseEntry(legacyWebPidPath(root), true);
  if (legacy && !entries.some((e) => e.port === legacy.port)) entries.push(legacy);
  return entries.sort((a, b) => a.port - b.port);
}

/** Removes `port`'s entry only while it still names `pid`: a newer server on that port keeps its own. */
export function clearWebServer(root: IRoot, port: number, pid: number): void {
  const entry = parseEntry(webServerPath(root, port), false);
  if (entry && entry.pid !== pid) return;
  rmSync(webServerPath(root, port), { force: true });
}

export function removeWebEntry(root: IRoot, entry: IWebEntry): void {
  if (entry.legacy) rmSync(legacyWebPidPath(root), { force: true });
  else clearWebServer(root, entry.port, entry.pid);
}
