import { type IArgs, need } from "../args.ts";
import { iso } from "../clock.ts";
import type { ICtx, IHandler } from "../context.ts";
import { rejected, usage } from "../errors.ts";
import { disabledMessage, isFlowDisabled } from "../flow/registry.ts";
import { addEvent, getItem, publicItem } from "../items.ts";

const MILESTONE_RE = /^milestone:([a-z0-9][a-z0-9_-]*)$/;

function run(ctx: ICtx, args: IArgs): void {
  const id = need(args.pos[0], "the item ID");
  const text = need(args.pos[1], "the text");
  if (args.pos.length > 2) throw usage("the text goes in one quoted argument");
  const kindArg = args.opts.kind ?? "note";
  const milestone = kindArg.match(MILESTONE_RE);
  if (!milestone && kindArg !== "note" && kindArg !== "user") {
    throw usage("--kind: note | user | milestone:<name>");
  }
  const kind = milestone ? "milestone" : kindArg;
  const item = getItem(ctx.db, id);
  if (isFlowDisabled(ctx.db, item.flow)) throw rejected(disabledMessage(item.flow));
  ctx.result.events.push(
    addEvent(ctx.db, {
      itemId: id,
      phase: item.phase,
      kind,
      text,
      actor: kind === "user" ? "user" : undefined,
      data: milestone ? { name: milestone[1] } : {},
    }),
  );
  ctx.db.query("UPDATE items SET updated_at = ? WHERE id = ?").run(iso(), id);
  ctx.result.item = publicItem(getItem(ctx.db, id));
  ctx.result.lines.push(`${id} · ${item.phase} · ${kindArg} · ${text}`);
}

export const logCmd: IHandler = { db: "write", run };
