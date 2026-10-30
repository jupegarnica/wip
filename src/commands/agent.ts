import { existsSync } from "node:fs";
import { agentFile } from "../agents.ts";
import { allow, type IArgs, need } from "../args.ts";
import { iso, now, parseIso } from "../clock.ts";
import type { ICtx, IHandler } from "../context.ts";
import type { TDatabase } from "../db.ts";
import { notFound, rejected, usage } from "../errors.ts";
import { assertItem } from "../invariants.ts";
import {
  AGENT_NAME_RE,
  addEvent,
  agentWaiting,
  getItem,
  openItem,
  phaseOf,
  publicItem,
  runningRuns,
  updateItem,
} from "../items.ts";
import { noExtra } from "./phase.ts";

export const STOP_STATUS = ["done", "blocked", "needs-input", "stopped"];

export function currentSession(db: TDatabase): string | null {
  const row = db
    .query("SELECT id FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1")
    .get() as { id: string } | null;
  return row?.id ?? null;
}

function start(ctx: ICtx, args: IArgs): void {
  allow(args, ["phase", "handle"]);
  const id = need(args.pos[1], "the item ID");
  const agent = need(args.pos[2], "the agent");
  noExtra(args, 3);
  if (!AGENT_NAME_RE.test(agent)) throw usage(`invalid agent name: ${agent}`);
  if (!existsSync(agentFile(ctx.root.agents, agent))) {
    throw notFound(`agent not found: ${agent} (no .agents/agents/${agent}.md)`);
  }
  const { item, flow } = openItem(ctx, id);
  const phase = args.opts.phase ?? item.phase;
  if (!phaseOf(flow, phase)) throw rejected(`I1 · phase ${phase} is not in flow ${flow.name}`);
  const handle = args.opts.handle ?? null;
  const db = ctx.db;
  const running = runningRuns(db, id);
  if (handle !== null && running.some((r) => r.handle === handle)) {
    ctx.result.warnings.push({
      code: "handle_running",
      message: `a run with handle ${handle} is already running`,
    });
    ctx.result.item = publicItem(item);
    ctx.result.lines.push(`${id} · ${agent} · no changes`);
    return;
  }
  const row = db
    .query(
      `INSERT INTO agent_runs (item_id, phase, agent, handle, session_id, started_at)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(id, phase, agent, handle, currentSession(db), iso()) as { id: number };
  const waiting = agentWaiting([...running.map((r) => r.agent), agent]) as string;
  updateItem(db, id, { waiting_on: waiting, next: null });
  ctx.result.events.push(
    addEvent(db, {
      itemId: id,
      phase,
      kind: "agent_start",
      text: `started ${agent}`,
      data: { agent, handle, run_id: row.id },
    }),
  );
  assertItem(db, id, flow);
  ctx.result.item = publicItem(getItem(db, id));
  ctx.result.data = { run_id: row.id };
  ctx.result.lines.push(
    `${id} · ${phase} · started ${agent}${handle ? ` (${handle})` : ""} · waiting_on ${waiting}`,
  );
}

function stop(ctx: ICtx, args: IArgs): void {
  allow(args, ["status", "summary", "next"]);
  const id = need(args.pos[1], "the item ID");
  const ref = need(args.pos[2], "the agent or the handle");
  noExtra(args, 3);
  const status = need(args.opts.status, "--status");
  if (!STOP_STATUS.includes(status)) throw usage(`--status: ${STOP_STATUS.join(" | ")}`);
  const { item, flow } = openItem(ctx, id);
  const db = ctx.db;
  const running = runningRuns(db, id);
  const byHandle = running.filter((r) => r.handle === ref);
  const matches = byHandle.length > 0 ? byHandle : running.filter((r) => r.agent === ref);
  if (matches.length === 0) throw rejected(`${id} has no running ${ref}`);
  if (matches.length > 1) {
    throw usage(`${ref} is ambiguous on ${id}: give the handle of one of its runs`);
  }
  const runRow = matches[0] as (typeof matches)[number];
  const summary = args.opts.summary ?? null;
  const seconds = Math.max(
    0,
    Math.round((now().getTime() - parseIso(runRow.started_at).getTime()) / 1000),
  );
  db.query(
    "UPDATE agent_runs SET status = ?, finished_at = ?, duration_s = ?, summary = ? WHERE id = ?",
  ).run(status, iso(), seconds, summary, runRow.id);

  let waiting = agentWaiting(running.filter((r) => r.id !== runRow.id).map((r) => r.agent));
  let next: string | null = args.opts.next ?? null;
  if (!waiting) {
    const def = phaseOf(flow, item.phase)?.waitingDefault ?? "agent";
    if (def === "agent" || def === "user") {
      waiting = "user";
      next ??= `review the result of ${runRow.agent}`;
    } else {
      waiting = def;
    }
  }
  updateItem(db, id, { waiting_on: waiting, next });
  const text = `${runRow.agent} ${status} (${seconds}s)${summary ? `: ${summary}` : ""}`;
  ctx.result.events.push(
    addEvent(db, {
      itemId: id,
      phase: runRow.phase,
      kind: "agent_stop",
      text,
      data: {
        agent: runRow.agent,
        handle: runRow.handle,
        run_id: runRow.id,
        status,
        duration_s: seconds,
      },
    }),
  );
  assertItem(db, id, flow);
  ctx.result.item = publicItem(getItem(db, id));
  ctx.result.data = { run_id: runRow.id, duration_s: seconds };
  ctx.result.lines.push(`${id} · ${runRow.phase} · ${text} · waiting_on ${waiting}`);
}

function run(ctx: ICtx, args: IArgs): void {
  const sub = args.pos[0];
  if (sub === "start") start(ctx, args);
  else if (sub === "stop") stop(ctx, args);
  else throw usage("usage: wip agent start|stop …");
}

export const agentCmd: IHandler = { db: "write", run };
