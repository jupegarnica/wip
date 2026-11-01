import { mkdirSync } from "node:fs";
import { forceReason, type IArgs, need } from "../args.ts";
import { iso, now } from "../clock.ts";
import type { ICtx, IHandler } from "../context.ts";
import type { TDatabase } from "../db.ts";
import { artifactDir, FLOW_SKILL_PREFIX } from "../env.ts";
import { notFound, rejected, usage } from "../errors.ts";
import type { IFlow, IPhase } from "../flow/parse.ts";
import { checkItemId, getFlow, loadFlows } from "../flow/registry.ts";
import { assertItem } from "../invariants.ts";
import {
  addEvent,
  agentWaiting,
  findItem,
  getItem,
  type IItemRow,
  phaseOf,
  publicItem,
  runningRuns,
  updateItem,
  WAITING_RE,
} from "../items.ts";

/** How far back a forced transition looks for a decision of the user on the item. */
export const FORCE_WINDOW_S = 600;

export function checkWaiting(value: string): string {
  if (!WAITING_RE.test(value)) {
    throw usage(`invalid wait '${value}': user | external | none | agent:<a>[,<b>]`);
  }
  return value;
}

export function noExtra(args: IArgs, max: number): void {
  if (args.pos.length > max) throw usage(`unexpected argument: ${args.pos.slice(max).join(" ")}`);
}

/** `waiting_on` when the command does not say it: the phase's `waiting_default`, running agents first. */
export function defaultWaiting(
  ctx: ICtx,
  item: IItemRow | null,
  phase: IPhase,
): { waiting: string; next: string | null } {
  if (phase.waitingDefault === "user") return { waiting: "user", next: `continue ${phase.name}` };
  if (phase.waitingDefault !== "agent") return { waiting: phase.waitingDefault, next: null };
  const live = item ? agentWaiting(runningRuns(ctx.db, item.id).map((r) => r.agent)) : null;
  if (live) return { waiting: live, next: null };
  ctx.result.warnings.push({
    code: "no_agent",
    message: `no --wait and no running agent: waiting_on user (next: launch ${phase.name})`,
  });
  return { waiting: "user", next: `launch ${phase.name}` };
}

/** The latest `user` or `gate_close` event of the item within FORCE_WINDOW_S: what a `--force` rests on. */
function userDecision(db: TDatabase, id: string): { id: number } | null {
  const since = iso(new Date(now().getTime() - FORCE_WINDOW_S * 1000));
  return db
    .query(
      `SELECT id FROM events WHERE item_id = ? AND kind IN ('user', 'gate_close') AND ts >= ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(id, since) as { id: number } | null;
}

/** Phases an item can move to from `from`: its `next`, then the `from_any` phases (none out of the terminal). */
export function allowedTargets(flow: IFlow, from: string): string[] {
  const phase = phaseOf(flow, from);
  const out = [...(phase?.next ?? [])];
  if (phase && phase.kind !== "terminal") {
    for (const p of flow.phases) {
      if (p.fromAny === true && p.name !== from && !out.includes(p.name)) out.push(p.name);
    }
  }
  return out;
}

function flowForNewItem(ctx: ICtx, wanted: string | undefined): IFlow {
  const set = loadFlows(ctx.root, ctx.db, { write: true });
  let name = wanted;
  if (name === undefined) {
    const names = [...set.entries.keys()].sort();
    if (names.length === 0) {
      throw notFound(
        `no flows in ${ctx.root.defsDir}/skills/${FLOW_SKILL_PREFIX}*/SKILL.md: create one first`,
      );
    }
    if (names.length > 1) {
      throw usage(`several flows (${names.join(", ")}): say which one with --flow`);
    }
    name = names[0] as string;
  }
  ctx.result.warnings.push(...set.warnings.filter((w) => w.flow === name));
  return getFlow(set, name);
}

function existingFlow(ctx: ICtx, item: IItemRow, wanted: string | undefined): IFlow {
  if (wanted !== undefined && wanted !== item.flow) {
    throw usage(`${item.id} belongs to flow ${item.flow}, not ${wanted}`);
  }
  if (item.status === "archived") throw rejected(`${item.id} is archived`);
  const set = loadFlows(ctx.root, ctx.db, { write: true });
  ctx.result.warnings.push(...set.warnings.filter((w) => w.flow === item.flow));
  return getFlow(set, item.flow);
}

function run(ctx: ICtx, args: IArgs): void {
  const id = need(args.pos[0], "the item ID");
  const target = need(args.pos[1], "the phase");
  noExtra(args, 2);
  const reason = forceReason(args);
  const explicitWait = args.opts.wait !== undefined ? checkWaiting(args.opts.wait) : null;
  const db = ctx.db;
  const existing = findItem(db, id);
  const flow = existing
    ? existingFlow(ctx, existing, args.opts.flow)
    : flowForNewItem(ctx, args.opts.flow);
  if (!existing) checkItemId(flow, id);
  const phase = phaseOf(flow, target);
  if (!phase) throw rejected(`I1 · phase ${target} is not in flow ${flow.name}`);

  const samePhase = existing?.phase === target;
  const nothingToDo =
    explicitWait === null && args.opts.next === undefined && args.opts.note === undefined;
  if (existing && samePhase && nothingToDo) {
    ctx.result.item = publicItem(existing);
    ctx.result.lines.push(`${id} · ${target} · no changes`);
    return;
  }

  if (existing && !samePhase) {
    const allowed = allowedTargets(flow, existing.phase);
    if (!allowed.includes(target)) {
      if (!reason) {
        throw rejected(
          `${existing.phase} → ${target} is not a transition of ${flow.name} (allowed: ${allowed.join(", ") || "none"}); --force --reason only after the user decides it`,
        );
      }
      const ref = userDecision(db, id);
      if (!ref) {
        throw rejected(
          `--force needs a decision of the user on ${id} in the last ${FORCE_WINDOW_S / 60} min: record it first (wip gate close, or wip log ${id} "…" --kind user)`,
        );
      }
      ctx.result.events.push(
        addEvent(db, {
          itemId: id,
          phase: existing.phase,
          kind: "correction",
          text: reason,
          data: { from: existing.phase, to: target, ref: ref.id },
        }),
      );
    } else if (reason) {
      ctx.result.warnings.push({
        code: "force_unused",
        message: `--force had no effect: ${existing.phase} → ${target} is allowed`,
      });
    }
  } else if (reason) {
    ctx.result.warnings.push({ code: "force_unused", message: "--force had no effect" });
  }

  let waiting: string;
  let next: string | null;
  if (explicitWait !== null) {
    waiting = explicitWait;
    next = args.opts.next ?? null;
  } else if (existing && samePhase) {
    waiting = existing.waiting_on ?? "user";
    next = args.opts.next ?? existing.next;
  } else {
    const d = defaultWaiting(ctx, existing, phase);
    waiting = d.waiting;
    next = args.opts.next ?? d.next;
  }

  const dir = artifactDir(ctx.root, flow.name, id);
  if (!existing) {
    const ts = iso();
    db.query(
      `INSERT INTO items (id, flow, phase, waiting_on, next, artifact_dir, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, flow.name, target, waiting, next, dir, ts, ts);
  } else {
    updateItem(db, id, { phase: target, waiting_on: waiting, next });
  }
  const from = existing?.phase ?? null;
  const text =
    args.opts.note ??
    (from === null
      ? `created in ${target}`
      : samePhase
        ? `stays in ${target}`
        : `${from} → ${target}`);
  ctx.result.events.push(
    addEvent(db, {
      itemId: id,
      phase: target,
      kind: "phase",
      text,
      data: { from, to: target, waiting_on: waiting, next },
    }),
  );
  assertItem(db, id, flow);
  if (!existing) mkdirSync(dir, { recursive: true });
  ctx.result.item = publicItem(getItem(db, id));
  ctx.result.lines.push(
    `${id} · ${flow.name} · ${from ?? "new"} → ${target} · waiting_on ${waiting}${next ? ` · next: ${next}` : ""}`,
  );
}

export const phaseCmd: IHandler = { db: "write", run };
