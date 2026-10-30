import { type IArgs, need } from "../args.ts";
import { parseIso } from "../clock.ts";
import type { ICtx, IHandler } from "../context.ts";
import type { TDatabase } from "../db.ts";
import { notFound, usage } from "../errors.ts";
import { type IFlowSet, loadFlows } from "../flow/registry.ts";
import {
  getItem,
  type IEventRow,
  type IGateRow,
  type IRunRow,
  publicEvent,
  publicItem,
} from "../items.ts";
import { type ISignals, itemSignals } from "../signals.ts";
import { type ITotals, itemTotals } from "../totals.ts";
import { noExtra } from "./phase.ts";

export interface IItemView {
  item: Record<string, unknown>;
  events: Record<string, unknown>[];
  agent_runs: IRunRow[];
  gates: IGateRow[];
  signals: ISignals;
  totals: ITotals;
}

export interface IShowOptions {
  log?: number;
  since?: string;
}

/** One item with its runs, gates, events, signals and totals: `wip show --json` and the web's item panel. */
export function itemView(
  db: TDatabase,
  flows: IFlowSet,
  id: string,
  options: IShowOptions = {},
): IItemView {
  const item = getItem(db, id);
  let events: IEventRow[];
  if (options.since !== undefined) {
    events = db
      .query("SELECT * FROM events WHERE item_id = ? AND ts >= ? ORDER BY id")
      .all(id, options.since) as IEventRow[];
  } else {
    events = db.query("SELECT * FROM events WHERE item_id = ? ORDER BY id").all(id) as IEventRow[];
    if (options.log !== undefined) events = events.slice(Math.max(0, events.length - options.log));
  }
  return {
    item: publicItem(item),
    events: events.map(publicEvent),
    agent_runs: db
      .query("SELECT * FROM agent_runs WHERE item_id = ? ORDER BY id")
      .all(id) as IRunRow[],
    gates: db.query("SELECT * FROM gates WHERE item_id = ? ORDER BY id").all(id) as IGateRow[],
    signals: itemSignals(db, item, flows.entries.get(item.flow)?.flow ?? null),
    totals: itemTotals(db, id),
  };
}

function textLines(view: IItemView): string[] {
  const it = view.item;
  const lines = [`${it.id} · ${it.flow} · ${it.phase} · ${it.waiting_on ?? "none"} · ${it.status}`];
  if (it.title) lines.push(`title: ${it.title}`);
  for (const [k, v] of Object.entries(it.fields as Record<string, unknown>)) {
    lines.push(`${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`);
  }
  if (it.next) lines.push(`next: ${it.next}`);
  if (it.artifact_dir) lines.push(`artifacts: ${it.artifact_dir}`);
  const t = view.totals;
  lines.push(
    `totals: ${t.runs} runs · agents ${t.agent_seconds}s · waiting on the user ${t.user_wait_seconds}s`,
  );
  if (view.agent_runs.length > 0) {
    lines.push("", "## Agents");
    for (const r of view.agent_runs) {
      const took = r.duration_s !== null ? ` · ${r.duration_s}s` : "";
      const handle = r.handle ? ` (${r.handle})` : "";
      lines.push(
        `- ${r.started_at} · ${r.phase} · ${r.agent}${handle} · ${r.status}${took}${r.summary ? ` · ${r.summary}` : ""}`,
      );
    }
  }
  if (view.gates.length > 0) {
    lines.push("", "## Gates");
    for (const g of view.gates) {
      const state = g.closed_at ? `closed ${g.closed_at} · ${g.answer ?? ""}` : "open";
      lines.push(`- ${g.opened_at} · ${g.phase} · ${state}${g.question ? ` · ${g.question}` : ""}`);
    }
  }
  lines.push(
    "",
    "## Log",
    ...view.events.map((e) => `- ${e.ts} · ${e.phase ?? "-"} · ${e.kind} · ${e.text ?? ""}`),
  );
  return lines;
}

function run(ctx: ICtx, args: IArgs): void {
  const id = need(args.pos[0], "the item ID");
  noExtra(args, 1);
  const { log, since } = args.opts;
  if (log !== undefined && since !== undefined) throw usage("--log and --since together");
  if (log !== undefined && !/^\d+$/.test(log)) throw usage("--log: an integer ≥ 0");
  if (since !== undefined) {
    try {
      parseIso(since);
    } catch {
      throw usage("--since: a UTC ISO time");
    }
  }
  const db = ctx.readDb;
  if (!db) throw notFound(`item not found: ${id}`);
  const flows = loadFlows(ctx.root, db);
  const view = itemView(db, flows, id, {
    log: log !== undefined ? Number(log) : undefined,
    since,
  });
  ctx.result.warnings.push(...flows.warnings.filter((w) => w.flow === view.item.flow));
  ctx.result.item = view.item;
  ctx.result.events = view.events;
  ctx.result.data = {
    agent_runs: view.agent_runs,
    gates: view.gates,
    signals: view.signals,
    totals: view.totals,
  };
  ctx.result.lines.push(...textLines(view));
}

export const showCmd: IHandler = { db: "read", run };
