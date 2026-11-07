import { forceReason, type IArgs, need } from "../args.ts";
import { iso, now, parseIso } from "../clock.ts";
import type { ICtx, IHandler } from "../context.ts";
import { rejected } from "../errors.ts";
import { assertItem } from "../invariants.ts";
import {
  addEvent,
  getItem,
  openGates,
  publicItem,
  runningRuns,
  updateItem,
  writeFlow,
} from "../items.ts";
import { noExtra } from "./phase.ts";
import { pruneItem } from "./prune.ts";

function run(ctx: ICtx, args: IArgs): void {
  const id = need(args.pos[0], "the item ID");
  noExtra(args, 1);
  const reason = forceReason(args);
  const db = ctx.db;
  const item = getItem(db, id);
  if (item.status === "archived") {
    ctx.result.item = publicItem(item);
    ctx.result.lines.push(`${id} · already archived`);
    return;
  }
  const flow = writeFlow(ctx, item.flow);
  const running = runningRuns(db, id);
  const gates = openGates(db, id);
  if ((running.length > 0 || gates.length > 0) && !reason) {
    throw rejected(
      `${id} has ${running.length} running agents and ${gates.length} open gates: finish them first, or --force --reason`,
    );
  }
  const ts = iso();
  if (reason) {
    for (const r of running) {
      const seconds = Math.max(
        0,
        Math.round((now().getTime() - parseIso(r.started_at).getTime()) / 1000),
      );
      db.query(
        "UPDATE agent_runs SET status = 'stopped', finished_at = ?, duration_s = ? WHERE id = ?",
      ).run(ts, seconds, r.id);
    }
    for (const g of gates) {
      db.query("UPDATE gates SET closed_at = ?, decision = 'archived' WHERE id = ?").run(ts, g.id);
    }
    ctx.result.events.push(
      addEvent(db, {
        itemId: id,
        phase: item.phase,
        kind: "correction",
        text: reason,
        data: {
          archive: true,
          stopped_runs: running.map((r) => r.id),
          closed_gates: gates.map((g) => g.id),
        },
      }),
    );
  }
  updateItem(db, id, { status: "archived", archived_at: ts, waiting_on: "none", next: null });
  ctx.result.events.push(
    addEvent(db, {
      itemId: id,
      phase: item.phase,
      kind: "archive",
      text: `archived in ${item.phase}`,
    }),
  );
  assertItem(db, id, flow);
  ctx.result.item = publicItem(getItem(db, id));
  // Last statement: prune never throws and never changes the exit code.
  const pruned = args.flags.has("no-prune") ? "" : pruneItem(ctx, getItem(db, id));
  ctx.result.lines.push(`${id} · archived in ${item.phase}${pruned}`);
}

export const archiveCmd: IHandler = { db: "write", run };
