import { iso } from "./clock.ts";
import type { ICtx } from "./context.ts";
import type { TDatabase } from "./db.ts";
import { notFound, rejected } from "./errors.ts";
import type { IFlow, IPhase } from "./flow/parse.ts";
import { getFlow, loadFlows } from "./flow/registry.ts";

export interface IItemRow {
  id: string;
  flow: string;
  title: string | null;
  phase: string;
  waiting_on: string | null;
  next: string | null;
  status: "open" | "archived";
  artifact_dir: string | null;
  fields: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface IEventRow {
  id: number;
  item_id: string | null;
  ts: string;
  phase: string | null;
  kind: string;
  actor: string | null;
  text: string | null;
  data: string;
}

export interface INewEvent {
  itemId: string | null;
  phase?: string | null;
  kind: string;
  text?: string | null;
  data?: Record<string, unknown>;
  actor?: string;
}

export interface IRunRow {
  id: number;
  item_id: string;
  phase: string;
  agent: string;
  handle: string | null;
  session_id: string | null;
  started_at: string;
  finished_at: string | null;
  status: string;
  duration_s: number | null;
  summary: string | null;
}

export interface IGateRow {
  id: number;
  item_id: string;
  phase: string;
  opened_at: string;
  closed_at: string | null;
  question: string | null;
  detail_path: string | null;
  answer: string | null;
  decision: string | null;
}

export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const AGENT_LIST = "[a-z0-9][a-z0-9_-]*";
export const WAITING_RE = new RegExp(`^(user|external|none|agent:${AGENT_LIST}(,${AGENT_LIST})*)$`);

export function findItem(db: TDatabase | null, id: string): IItemRow | null {
  if (!db) return null;
  return db.query("SELECT * FROM items WHERE id = ?").get(id) as IItemRow | null;
}

export function getItem(db: TDatabase | null, id: string): IItemRow {
  const item = findItem(db, id);
  if (!item) throw notFound(`item not found: ${id}`);
  return item;
}

export function itemFields(item: IItemRow): Record<string, unknown> {
  return JSON.parse(item.fields || "{}") as Record<string, unknown>;
}

export function publicItem(item: IItemRow): Record<string, unknown> {
  return { ...item, fields: itemFields(item) };
}

export function publicEvent(event: IEventRow): Record<string, unknown> {
  return { ...event, data: JSON.parse(event.data || "{}") as unknown };
}

export function addEvent(db: TDatabase, ev: INewEvent): Record<string, unknown> {
  const row = db
    .query(
      `INSERT INTO events (item_id, ts, phase, kind, actor, text, data)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      ev.itemId,
      iso(),
      ev.phase ?? null,
      ev.kind,
      ev.actor ?? "coordinator",
      ev.text ?? null,
      JSON.stringify(ev.data ?? {}),
    ) as IEventRow;
  return publicEvent(row);
}

export function updateItem(db: TDatabase, id: string, patch: Record<string, unknown>): void {
  const keys = Object.keys(patch);
  const sets = [...keys.map((k) => `${k} = ?`), "updated_at = ?"].join(", ");
  const values = [...keys.map((k) => patch[k]), iso(), id] as (string | number | null)[];
  db.query(`UPDATE items SET ${sets} WHERE id = ?`).run(...values);
}

export function runningRuns(db: TDatabase, id: string): IRunRow[] {
  return db
    .query("SELECT * FROM agent_runs WHERE item_id = ? AND status = 'running' ORDER BY id")
    .all(id) as IRunRow[];
}

export function openGates(db: TDatabase, id: string): IGateRow[] {
  return db
    .query("SELECT * FROM gates WHERE item_id = ? AND closed_at IS NULL ORDER BY id")
    .all(id) as IGateRow[];
}

export function agentWaiting(names: readonly string[]): string | null {
  const unique = [...new Set(names)];
  return unique.length > 0 ? `agent:${unique.join(",")}` : null;
}

export function waitingAgents(waiting: string | null): string[] {
  return waiting?.startsWith("agent:") ? waiting.slice("agent:".length).split(",") : [];
}

export function phaseOf(flow: IFlow, name: string): IPhase | undefined {
  return flow.phases.find((p) => p.name === name);
}

/** Every terminal phase of the flow: a flow may have one or more. */
export function terminalPhases(flow: IFlow): IPhase[] {
  return flow.phases.filter((p) => p.kind === "terminal");
}

/** Whether `phaseName` is one of the flow's terminal phases. */
export function isTerminal(flow: IFlow, phaseName: string): boolean {
  return terminalPhases(flow).some((p) => p.name === phaseName);
}

/** Loads the flows for a write command and returns the active version of `name`, with its warnings. */
export function writeFlow(ctx: ICtx, name: string): IFlow {
  const set = loadFlows(ctx.root, ctx.db, { write: true });
  ctx.result.warnings.push(...set.warnings.filter((w) => w.flow === name));
  return getFlow(set, name);
}

/** The item a write command changes, with its flow; archived items only change through `archive`. */
export function openItem(ctx: ICtx, id: string): { item: IItemRow; flow: IFlow } {
  const item = getItem(ctx.db, id);
  if (item.status === "archived") throw rejected(`${id} is archived`);
  return { item, flow: writeFlow(ctx, item.flow) };
}
