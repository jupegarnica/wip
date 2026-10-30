import { resolve } from "node:path";
import { allow, type IArgs, need } from "../args.ts";
import { iso } from "../clock.ts";
import type { ICtx, IHandler } from "../context.ts";
import { rejected, usage } from "../errors.ts";
import { assertItem } from "../invariants.ts";
import {
  addEvent,
  getItem,
  openGates,
  openItem,
  phaseOf,
  publicItem,
  updateItem,
} from "../items.ts";
import { checkWaiting, noExtra } from "./phase.ts";

function open(ctx: ICtx, args: IArgs): void {
  allow(args, ["question", "detail"]);
  const id = need(args.pos[1], "the item ID");
  noExtra(args, 3);
  const question = need(args.opts.question, "--question");
  const detail = args.opts.detail !== undefined ? resolve(ctx.cwd, args.opts.detail) : null;
  const { item, flow } = openItem(ctx, id);
  const phase = args.pos[2] ?? item.phase;
  if (!phaseOf(flow, phase)) throw rejected(`I1 · phase ${phase} is not in flow ${flow.name}`);
  const db = ctx.db;
  if (openGates(db, id).some((g) => g.phase === phase)) {
    throw rejected(`${id} already has an open gate in ${phase}`);
  }
  const gate = db
    .query(
      `INSERT INTO gates (item_id, phase, opened_at, question, detail_path)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(id, phase, iso(), question, detail) as { id: number };
  updateItem(db, id, { waiting_on: "user", next: null });
  ctx.result.events.push(
    addEvent(db, {
      itemId: id,
      phase,
      kind: "gate_open",
      text: `gate ${phase} open: ${question}`,
      data: { gate_id: gate.id, detail },
    }),
  );
  assertItem(db, id, flow);
  ctx.result.item = publicItem(getItem(db, id));
  ctx.result.data = { gate_id: gate.id };
  ctx.result.lines.push(`${id} · gate ${phase} open · waiting_on user`);
}

function close(ctx: ICtx, args: IArgs): void {
  allow(args, ["answer", "decision", "wait", "next"]);
  const id = need(args.pos[1], "the item ID");
  noExtra(args, 3);
  const answer = need(args.opts.answer, "--answer (the user's literal answer)");
  const explicitWait = args.opts.wait !== undefined ? checkWaiting(args.opts.wait) : null;
  const { item, flow } = openItem(ctx, id);
  const db = ctx.db;
  const gates = openGates(db, id);
  const phase = args.pos[2];
  const matches = phase ? gates.filter((g) => g.phase === phase) : gates;
  if (matches.length === 0) throw rejected(`${id} has no open gate${phase ? ` in ${phase}` : ""}`);
  if (matches.length > 1) {
    throw usage(
      `${id} has several open gates (${matches.map((g) => g.phase).join(", ")}): say which phase`,
    );
  }
  const gate = matches[0] as (typeof matches)[number];
  const decision = args.opts.decision ?? null;
  db.query("UPDATE gates SET closed_at = ?, answer = ?, decision = ? WHERE id = ?").run(
    iso(),
    answer,
    decision,
    gate.id,
  );
  let waiting: string;
  let next: string | null = args.opts.next ?? null;
  if (explicitWait !== null) waiting = explicitWait;
  else {
    waiting = item.waiting_on ?? "user";
    if (waiting === "user" && gates.length === 1) {
      next ??= `apply the ${decision ?? "answer"} of gate ${gate.phase}`;
    }
  }
  updateItem(db, id, { waiting_on: waiting, next });
  ctx.result.events.push(
    addEvent(db, {
      itemId: id,
      phase: gate.phase,
      kind: "gate_close",
      text: `gate ${gate.phase} closed: ${answer}`,
      actor: "user",
      data: { gate_id: gate.id, answer, decision },
    }),
  );
  assertItem(db, id, flow);
  ctx.result.item = publicItem(getItem(db, id));
  ctx.result.data = { gate_id: gate.id };
  ctx.result.lines.push(
    `${id} · gate ${gate.phase} closed${decision ? ` (${decision})` : ""} · waiting_on ${waiting}${next ? ` · next: ${next}` : ""}`,
  );
}

function run(ctx: ICtx, args: IArgs): void {
  const sub = args.pos[0];
  if (sub === "open") open(ctx, args);
  else if (sub === "close") close(ctx, args);
  else throw usage("usage: wip gate open|close …");
}

export const gateCmd: IHandler = { db: "write", run };
