import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { iso } from "../clock.ts";
import type { IRoot } from "../env.ts";

export interface IWebPid {
  pid: number;
  port: number;
  project: string;
  /** ISO 8601 UTC. */
  started_at: string;
}

export function webPidPath(root: IRoot): string {
  return join(root.wip, "web.pid");
}

export function writeWebPid(root: IRoot, port: number): IWebPid {
  const entry: IWebPid = { pid: process.pid, port, project: root.project, started_at: iso() };
  writeFileSync(webPidPath(root), `${JSON.stringify(entry)}\n`);
  return entry;
}

/** Null when there is no pidfile or it is not one this build wrote. */
export function readWebPid(root: IRoot): IWebPid | null {
  try {
    const entry = JSON.parse(readFileSync(webPidPath(root), "utf8")) as IWebPid;
    return Number.isInteger(entry?.pid) && Number.isInteger(entry?.port) ? entry : null;
  } catch {
    return null;
  }
}

/** Removes the pidfile only while it still names `pid`: a newer server keeps its own. */
export function clearWebPid(root: IRoot, pid?: number): void {
  const entry = readWebPid(root);
  if (pid !== undefined && entry && entry.pid !== pid) return;
  rmSync(webPidPath(root), { force: true });
}
