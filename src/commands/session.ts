import type { IArgs } from "../args.ts";
import { iso } from "../clock.ts";
import type { ICtx, IHandler } from "../context.ts";
import { usage } from "../errors.ts";
import { getFlow, loadFlows } from "../flow/registry.ts";
import { assertItem } from "../invariants.ts";
import { addEvent, getItem, type IRunRow, terminalPhase, updateItem } from "../items.ts";
import { noExtra } from "./phase.ts";

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** No runtime keeps its subagents across a restart: every run left `running` becomes `orphaned`. */
function run(ctx: ICtx, args: IArgs): void {
  if (args.pos[0] !== "start") throw usage("usage: wip session start [--id S]");
  noExtra(args, 1);
  const id = args.opts.id ?? crypto.randomUUID();
  if (!SESSION_ID_RE.test(id)) throw usage(`invalid session id: ${id}`);
  const db = ctx.db;
  if (db.query("SELECT 1 FROM sessions WHERE id = ?").get(id)) {
    throw usage(`session ${id} already exists`);
  }
  const ts = iso();
  db.query("UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL").run(ts);
  db.query("INSERT INTO sessions (id, started_at) VALUES (?, ?)").run(id, ts);
  ctx.result.events.push(addEvent(db, { itemId: null, kind: "session", text: `session ${id}` }));

  const runs = db
    .query("SELECT * FROM agent_runs WHERE status = 'running' ORDER BY item_id, id")
    .all() as IRunRow[];
  const byItem = new Map<string, IRunRow[]>();
  for (const r of runs) {
    db.query("UPDATE agent_runs SET status = 'orphaned', finished_at = ? WHERE id = ?").run(
      ts,
      r.id,
    );
    byItem.set(r.item_id, [...(byItem.get(r.item_id) ?? []), r]);
  }
  const flows = byItem.size > 0 ? loadFlows(ctx.root, db, { write: true }) : null;
  const lines: string[] = [];
  for (const [itemId, itemRuns] of byItem) {
    const item = getItem(db, itemId);
    for (const r of itemRuns) {
      ctx.result.events.push(
        addEvent(db, {
          itemId,
          phase: r.phase,
          kind: "agent_stop",
          text: `${r.agent} orphaned (previous session)`,
          data: { agent: r.agent, handle: r.handle, run_id: r.id, status: "orphaned" },
        }),
      );
    }
    if (item.status === "archived" || !flows) continue;
    if (flows.disabled.has(item.flow)) continue;
    const flow = getFlow(flows, item.flow);
    const terminal = item.phase === terminalPhase(flow)?.name;
    const agents = [...new Set(itemRuns.map((r) => r.agent))].join(", ");
    const waiting = terminal ? "none" : "user";
    const next = terminal ? null : `relaunch ${item.phase} (${agents}) or decide`;
    updateItem(db, itemId, { waiting_on: waiting, next });
    ctx.result.events.push(
      addEvent(db, {
        itemId,
        phase: item.phase,
        kind: "wait",
        text: next ? `waiting_on user · next: ${next}` : "waiting_on none",
        data: { waiting_on: waiting, next },
      }),
    );
    assertItem(db, itemId, flow);
    lines.push(
      `${itemId} · ${item.phase} · waiting_on ${waiting}${next ? ` · next: ${next}` : ""}`,
    );
  }
  ctx.result.data = { session: id, orphaned: runs.map((r) => r.id) };
  ctx.result.lines.push(`session ${id} · ${runs.length} runs orphaned`, ...lines);
}

export const sessionCmd: IHandler = { db: "write", run };
