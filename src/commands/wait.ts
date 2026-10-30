import { type IArgs, need } from "../args.ts";
import type { ICtx, IHandler } from "../context.ts";
import { assertItem } from "../invariants.ts";
import { addEvent, getItem, openItem, publicItem, updateItem } from "../items.ts";
import { checkWaiting, noExtra } from "./phase.ts";

function run(ctx: ICtx, args: IArgs): void {
  const id = need(args.pos[0], "the item ID");
  const who = checkWaiting(need(args.pos[1], "who the item waits on"));
  noExtra(args, 2);
  const { item, flow } = openItem(ctx, id);
  const next = args.opts.next ?? null;
  if (item.waiting_on === who && item.next === next) {
    ctx.result.item = publicItem(item);
    ctx.result.lines.push(`${id} · waiting_on ${who} · no changes`);
    return;
  }
  updateItem(ctx.db, id, { waiting_on: who, next });
  ctx.result.events.push(
    addEvent(ctx.db, {
      itemId: id,
      phase: item.phase,
      kind: "wait",
      text: next ? `waiting_on ${who} · next: ${next}` : `waiting_on ${who}`,
      data: { waiting_on: who, next },
    }),
  );
  assertItem(ctx.db, id, flow);
  ctx.result.item = publicItem(getItem(ctx.db, id));
  ctx.result.lines.push(`${id} · waiting_on ${who}${next ? ` · next: ${next}` : ""}`);
}

export const waitCmd: IHandler = { db: "write", run };
