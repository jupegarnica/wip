import { type IArgs, need } from "../args.ts";
import { iso, now, parseIso } from "../clock.ts";
import type { ICtx, IHandler } from "../context.ts";
import type { TDatabase } from "../db.ts";
import { notFound, rejected, usage } from "../errors.ts";
import type { IFlow, IPoll } from "../flow/parse.ts";
import { getFlow, loadFlows } from "../flow/registry.ts";
import { AGENT_NAME_RE, findItem } from "../items.ts";
import { activeSeen, pollLine, pollRows } from "../poll.ts";
import { parseWhen } from "../when.ts";
import { noExtra } from "./phase.ts";

const KEY_MAX = 200;

function pollOf(flow: IFlow, name: string): IPoll {
  const polls = flow.polling ?? [];
  const found = polls.find((p) => p.name === name);
  if (!found) {
    throw notFound(
      `poll not found: ${flow.name}/${name} (polls: ${polls.map((p) => p.name).join(", ") || "none"})`,
    );
  }
  return found;
}

function due(ctx: ICtx, args: IArgs): void {
  noExtra(args, 1);
  const db = ctx.readDb;
  const set = loadFlows(ctx.root, db);
  const wanted = args.opts.flow;
  if (wanted !== undefined && !set.entries.has(wanted)) {
    throw notFound(`flow not found: ${wanted}`);
  }
  ctx.result.warnings.push(
    ...set.warnings.filter((w) => wanted === undefined || w.flow === wanted),
  );
  const at = now();
  const polls = pollRows(db, set, at, { flow: wanted });
  ctx.result.data = { now: iso(at), polls };
  for (const row of polls) ctx.result.lines.push(pollLine(row));
  if (polls.length === 0) ctx.result.lines.push("no polling declared");
}

function itemIds(ctx: ICtx, flow: string, raw: string): string[] {
  if (raw === "none") return [];
  const ids = [...new Set(raw.split(",").map((s) => s.trim()))];
  if (ids.some((id) => id === "")) throw usage("--items: a list of item IDs, or none");
  for (const id of ids) {
    const item = findItem(ctx.db, id);
    if (!item) throw notFound(`item not found: ${id}`);
    if (item.status === "archived") throw rejected(`${id} is archived`);
    if (item.flow !== flow) throw rejected(`${id} belongs to flow ${item.flow}, not ${flow}`);
  }
  return ids;
}

function record(ctx: ICtx, args: IArgs): void {
  const flowName = need(args.pos[1], "the flow");
  const pollName = need(args.pos[2], "the poll");
  noExtra(args, 3);
  const set = loadFlows(ctx.root, ctx.db, { write: true });
  ctx.result.warnings.push(...set.warnings.filter((w) => w.flow === flowName));
  const flow = getFlow(set, flowName);
  const poll = pollOf(flow, pollName);
  const agent = args.opts.agent ?? poll.agent;
  if (!AGENT_NAME_RE.test(agent)) throw usage(`invalid agent name '${agent}'`);
  const at = now();
  const ids =
    args.opts.items !== undefined
      ? itemIds(ctx, flowName, args.opts.items)
      : (pollRows(ctx.db, set, at, { flow: flowName, poll: pollName })[0]?.items ?? []).map(
          (i) => i.id,
        );
  const result = args.opts.result ?? null;
  const ts = iso(at);
  const run = ctx.db
    .query(
      "INSERT INTO poll_runs (flow, poll, agent, ts, result) VALUES (?, ?, ?, ?, ?) RETURNING id",
    )
    .get(flowName, pollName, agent, ts, result) as { id: number };
  for (const id of ids) {
    ctx.db.query("INSERT INTO poll_run_items (run_id, item_id) VALUES (?, ?)").run(run.id, id);
  }
  ctx.result.data = {
    run: { id: run.id, flow: flowName, poll: pollName, agent, ts, items: ids, result },
  };
  ctx.result.lines.push(
    `${flowName}/${pollName} · pass ${ts} · items: ${ids.join(", ") || "none"}${result ? ` · ${result}` : ""}`,
  );
}

/** `--until` keeps its own narrow grammar (`+<N>h`, `+<N>d` or UTC ISO with `Z`); the shared `--at` parser does the rest. */
function untilOf(raw: string, at: Date): string {
  let narrow = /^\+([1-9][0-9]*)([hd])$/.test(raw);
  if (!narrow) {
    try {
      parseIso(raw);
      narrow = true;
    } catch {}
  }
  if (!narrow) {
    throw usage(`--until '${raw}': a UTC ISO time (2026-11-01T10:00:00Z), +<N>h or +<N>d`);
  }
  return iso(parseWhen(raw, at, "--until"));
}

function seenLine(s: { key: string; seen_at: string; until: string | null; note: string | null }) {
  return `${s.key} · seen ${s.seen_at} · ${s.until ? `until ${s.until}` : "for good"}${s.note ? ` · ${s.note}` : ""}`;
}

function seen(ctx: ICtx, args: IArgs): void {
  const flowName = need(args.pos[1], "the flow");
  const pollName = need(args.pos[2], "the poll");
  const key = args.pos[3];
  noExtra(args, 4);
  const remove = args.flags.has("remove");
  const all = args.flags.has("all");
  if (key === undefined) {
    if (remove || args.opts.until !== undefined || args.opts.note !== undefined) {
      throw usage("--until, --note and --remove need a key");
    }
  } else {
    if (key.trim() === "" || key.length > KEY_MAX || /[\r\n]/.test(key)) {
      throw usage(`the key is one line of 1 to ${KEY_MAX} characters`);
    }
    if (all) throw usage("--all only lists: give no key");
    if (remove && (args.opts.until !== undefined || args.opts.note !== undefined)) {
      throw usage("--remove takes no --until nor --note");
    }
  }
  const set = loadFlows(ctx.root, ctx.db, { write: true });
  ctx.result.warnings.push(...set.warnings.filter((w) => w.flow === flowName));
  pollOf(getFlow(set, flowName), pollName);
  const at = now();
  const db: TDatabase = ctx.db;
  if (key === undefined) {
    const list = activeSeen(db, flowName, pollName, at, all);
    ctx.result.data = { seen: list };
    for (const s of list) ctx.result.lines.push(seenLine(s));
    if (list.length === 0) ctx.result.lines.push(`${flowName}/${pollName} · nothing seen`);
    return;
  }
  if (remove) {
    const gone = db
      .query("DELETE FROM poll_seen WHERE flow = ? AND poll = ? AND key = ?")
      .run(flowName, pollName, key);
    if (gone.changes === 0) throw notFound(`${flowName}/${pollName} has not seen '${key}'`);
    ctx.result.data = { removed: key };
    ctx.result.lines.push(`${flowName}/${pollName} · forgot ${key}`);
    return;
  }
  const until = args.opts.until === undefined ? null : untilOf(args.opts.until, at);
  const note = args.opts.note ?? null;
  const seenAt = iso(at);
  db.query(
    `INSERT INTO poll_seen (flow, poll, key, seen_at, until, note) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(flow, poll, key) DO UPDATE SET seen_at = excluded.seen_at,
       until = excluded.until, note = excluded.note`,
  ).run(flowName, pollName, key, seenAt, until, note);
  const entry = { key, seen_at: seenAt, until, note };
  ctx.result.data = { seen: [entry] };
  ctx.result.lines.push(`${flowName}/${pollName} · ${seenLine(entry)}`);
}

/** `due` reads; `record` and `seen` write. The handler mode is per command, so cli.ts picks by sub-command. */
export const POLL_HANDLERS: Readonly<Record<string, IHandler>> = {
  due: { db: "read", run: due },
  record: { db: "write", run: record },
  seen: { db: "write", run: seen },
};

export const pollCmd: IHandler = {
  db: "none",
  run: () => {
    throw usage("usage: wip poll due | record | seen (run `wip poll --help`)");
  },
};
