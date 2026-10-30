import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { iso } from "../clock.ts";
import type { IWarning } from "../context.ts";
import type { TDatabase } from "../db.ts";
import type { IRoot } from "../env.ts";
import { EXIT, notFound, usage, WipError } from "../errors.ts";
import { type ILiveItem, lintFlow } from "./lint.ts";
import type { IFlow } from "./parse.ts";

/** `file`: the file passes lint · `stored`: last valid version from `flows` · `null`: unusable. */
export type TFlowSource = "file" | "stored" | null;

export interface IFlowEntry {
  name: string;
  path: string;
  /** Problems of the file as it is now; empty when it is the active version. */
  problems: string[];
  source: TFlowSource;
  flow: IFlow | null;
  stored: { hash: string; loadedAt: string } | null;
}

export interface IFlowSet {
  entries: Map<string, IFlowEntry>;
  warnings: IWarning[];
}

export interface ILoadOptions {
  /** A write transaction: valid files whose hash changed are recorded as the last valid version. */
  write?: boolean;
}

interface IStoredRow {
  name: string;
  path: string;
  hash: string;
  json: string;
  loaded_at: string;
}

interface IStoredJson {
  block: string;
  flow: IFlow;
}

export const DEFAULT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function flowFiles(flowsDir: string): string[] {
  if (!existsSync(flowsDir)) return [];
  return readdirSync(flowsDir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".md") && d.name !== "README.md")
    .map((d) => join(flowsDir, d.name))
    .sort();
}

function storedRows(db: TDatabase | null): Map<string, IStoredRow> {
  if (!db) return new Map();
  const rows = db
    .query("SELECT name, path, hash, json, loaded_at FROM flows")
    .all() as IStoredRow[];
  return new Map(rows.map((r) => [r.name, r]));
}

function liveItems(db: TDatabase | null): Map<string, ILiveItem[]> {
  const byFlow = new Map<string, ILiveItem[]>();
  if (!db) return byFlow;
  const rows = db
    .query("SELECT id, flow, phase FROM items WHERE status = 'open' ORDER BY id")
    .all() as { id: string; flow: string; phase: string }[];
  for (const r of rows) {
    const list = byFlow.get(r.flow) ?? [];
    list.push({ id: r.id, phase: r.phase });
    byFlow.set(r.flow, list);
  }
  return byFlow;
}

function record(db: TDatabase, path: string, flow: IFlow, block: string): void {
  const json: IStoredJson = { block, flow };
  db.query(
    `INSERT INTO flows (name, path, hash, json, loaded_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET path = excluded.path, hash = excluded.hash,
       json = excluded.json, loaded_at = excluded.loaded_at`,
  ).run(flow.name, path, flow.hash, JSON.stringify(json), iso());
}

function fallback(
  entry: IFlowEntry,
  row: IStoredRow | undefined,
  code: "flow_invalid" | "flow_missing",
): IWarning {
  if (row) {
    entry.source = "stored";
    entry.flow = (JSON.parse(row.json) as IStoredJson).flow;
    entry.stored = { hash: row.hash, loadedAt: row.loaded_at };
  }
  const using = row
    ? `using its last valid version ${row.hash} from ${row.loaded_at}`
    : "it has no valid version, so commands on it fail";
  return {
    code,
    message:
      code === "flow_missing"
        ? `flow ${entry.name} has no file at ${entry.path} but has open items; ${using}`
        : `flow ${entry.name} does not pass \`wip flow lint ${entry.name}\`; ${using}`,
    flow: entry.name,
    using: row ? row.hash : null,
    problems: entry.problems,
  };
}

/**
 * Discovers `.agents/flows/*.md` on every call: creating a file creates the flow. A file that fails lint
 * is never loaded; its last valid version from `flows` stands in, with a warning (F-NEW-04).
 */
export function loadFlows(root: IRoot, db: TDatabase | null, options: ILoadOptions = {}): IFlowSet {
  const stored = storedRows(db);
  const items = liveItems(db);
  const entries = new Map<string, IFlowEntry>();
  const warnings: IWarning[] = [];
  for (const file of flowFiles(root.flows)) {
    const name = basename(file, ".md");
    const path = relative(root.project, file);
    const result = lintFlow({
      name,
      text: readFileSync(file, "utf8"),
      agentsDir: root.agents,
      liveItems: items.get(name) ?? [],
    });
    const row = stored.get(name);
    const entry: IFlowEntry = {
      name,
      path,
      problems: result.problems,
      source: null,
      flow: null,
      stored: row ? { hash: row.hash, loadedAt: row.loaded_at } : null,
    };
    entries.set(name, entry);
    if (result.problems.length === 0 && result.flow && result.block !== null) {
      entry.source = "file";
      entry.flow = result.flow;
      if (options.write && db && row?.hash !== result.flow.hash) {
        record(db, path, result.flow, result.block);
        entry.stored = { hash: result.flow.hash, loadedAt: iso() };
      }
      continue;
    }
    warnings.push(fallback(entry, row, "flow_invalid"));
  }
  for (const [name, row] of stored) {
    if (entries.has(name) || !items.has(name)) continue;
    const entry: IFlowEntry = {
      name,
      path: row.path,
      problems: [`no file ${row.path}; its open items still use the last valid version`],
      source: null,
      flow: null,
      stored: null,
    };
    entries.set(name, entry);
    warnings.push(fallback(entry, row, "flow_missing"));
  }
  return { entries, warnings };
}

/** The active version of a flow: exit 4 when it does not exist, 1 when it has no valid version. */
export function getFlow(set: IFlowSet, name: string): IFlow {
  const entry = set.entries.get(name);
  if (!entry) throw notFound(`flow not found: ${name} (no .agents/flows/${name}.md)`);
  if (!entry.flow) {
    throw new WipError(
      EXIT.FINDINGS,
      `flow ${name} does not pass lint and has no valid version; run \`wip flow lint ${name}\``,
    );
  }
  return entry.flow;
}

/** The ID is stored as given: the safe default always applies, and the flow's `id_pattern` too. */
export function checkItemId(flow: IFlow, id: string): void {
  if (!DEFAULT_ID_RE.test(id)) {
    throw usage(
      `invalid ID '${id}': letters, digits, '.', '_' and '-', starting with a letter or digit, up to 64`,
    );
  }
  if (flow.idPattern !== null && !new RegExp(`^(?:${flow.idPattern})$`).test(id)) {
    throw usage(`invalid ID '${id}' for flow ${flow.name}: it must match ${flow.idPattern}`);
  }
}
