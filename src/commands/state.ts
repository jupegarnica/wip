import type { IArgs } from "../args.ts";
import type { ICtx, IHandler } from "../context.ts";
import type { TDatabase } from "../db.ts";
import { usage } from "../errors.ts";
import { type IFlowSet, loadFlows } from "../flow/registry.ts";
import { type IItemRow, itemFields, openGates, runningRuns } from "../items.ts";
import { type ISignals, itemSignals } from "../signals.ts";
import { noExtra } from "./phase.ts";

export interface IStateItem {
  id: string;
  flow: string;
  title: string | null;
  phase: string;
  waiting_on: string | null;
  next: string | null;
  status: "open" | "archived";
  artifact_dir: string | null;
  fields: Record<string, unknown>;
  updated_at: string;
  archived_at: string | null;
  agents: { agent: string; phase: string; handle: string | null; started_at: string }[];
  open_gates: { phase: string; question: string | null; opened_at: string }[];
  signals: ISignals;
  /** Only with `grep`: the item's events whose text matches, in order. */
  matches?: { id: number; ts: string; phase: string | null; kind: string; text: string | null }[];
}

export interface IStateFilter {
  flow?: string;
  waiting?: string;
  archived?: boolean;
  attention?: boolean;
  grep?: string;
}

/** `agent` matches every `agent:<name>`; any other value matches exactly. */
function waitingMatches(value: string | null, wanted: string): boolean {
  if (wanted === "agent") return (value ?? "").startsWith("agent:");
  return value === wanted;
}

/** The items of `wip state`; `attention: true` is the web's «your turn». */
export function listState(
  db: TDatabase | null,
  flows: IFlowSet,
  filter: IStateFilter = {},
): IStateItem[] {
  if (!db) return [];
  const rows = db
    .query("SELECT * FROM items WHERE status = ? ORDER BY flow, id")
    .all(filter.archived ? "archived" : "open") as IItemRow[];
  const needle = filter.grep?.toLowerCase();
  const out: IStateItem[] = [];
  for (const item of rows) {
    if (filter.flow !== undefined && item.flow !== filter.flow) continue;
    if (filter.waiting !== undefined && !waitingMatches(item.waiting_on, filter.waiting)) continue;
    const signals = itemSignals(db, item, flows.entries.get(item.flow)?.flow ?? null);
    if (filter.attention && !signals.attention) continue;
    let matches: IStateItem["matches"];
    if (needle !== undefined) {
      matches = (
        db
          .query("SELECT id, ts, phase, kind, text FROM events WHERE item_id = ? ORDER BY id")
          .all(item.id) as NonNullable<IStateItem["matches"]>
      ).filter((e) => (e.text ?? "").toLowerCase().includes(needle));
      const inItem = `${item.id} ${item.title ?? ""}`.toLowerCase().includes(needle);
      if (matches.length === 0 && !inItem) continue;
    }
    out.push({
      id: item.id,
      flow: item.flow,
      title: item.title,
      phase: item.phase,
      waiting_on: item.waiting_on,
      next: item.next,
      status: item.status,
      artifact_dir: item.artifact_dir,
      fields: itemFields(item),
      updated_at: item.updated_at,
      archived_at: item.archived_at,
      agents: runningRuns(db, item.id).map((r) => ({
        agent: r.agent,
        phase: r.phase,
        handle: r.handle,
        started_at: r.started_at,
      })),
      open_gates: openGates(db, item.id).map((g) => ({
        phase: g.phase,
        question: g.question,
        opened_at: g.opened_at,
      })),
      signals,
      ...(matches ? { matches } : {}),
    });
  }
  return out;
}

export function stateLine(s: IStateItem): string {
  const parts = [s.id, s.flow, s.phase, s.waiting_on ?? "none"];
  if (s.title) parts.push(s.title);
  if (s.next) parts.push(`next: ${s.next}`);
  if (s.agents.length > 0) parts.push(`agents: ${s.agents.map((a) => a.agent).join(", ")}`);
  for (const g of s.open_gates) parts.push(`gate ${g.phase}: ${g.question ?? ""}`);
  if (s.signals.attention) parts.push("your turn");
  if (s.signals.incoherent.length > 0) parts.push(`! ${s.signals.incoherent.join(",")}`);
  return parts.join(" · ");
}

function run(ctx: ICtx, args: IArgs): void {
  noExtra(args, 0);
  const grep = args.opts.grep;
  if (grep !== undefined && grep.trim() === "") throw usage("--grep is empty");
  const db = ctx.readDb;
  const flows = loadFlows(ctx.root, db);
  if (args.opts.flow !== undefined) {
    ctx.result.warnings.push(...flows.warnings.filter((w) => w.flow === args.opts.flow));
  } else ctx.result.warnings.push(...flows.warnings);
  const items = listState(db, flows, {
    flow: args.opts.flow,
    waiting: args.opts.waiting,
    archived: args.flags.has("archived"),
    attention: args.flags.has("attention"),
    grep,
  });
  ctx.result.data = { items };
  for (const s of items) {
    ctx.result.lines.push(stateLine(s));
    for (const m of s.matches ?? []) {
      ctx.result.lines.push(`  - ${m.ts} · ${m.phase ?? "-"} · ${m.text ?? ""}`);
    }
  }
  if (items.length === 0) ctx.result.lines.push("no items");
}

export const stateCmd: IHandler = { db: "read", run };
