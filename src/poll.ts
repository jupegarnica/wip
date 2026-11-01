import { iso } from "./clock.ts";
import type { TDatabase } from "./db.ts";
import type { IPoll } from "./flow/parse.ts";
import type { IFlowSet } from "./flow/registry.ts";

/** A poll is OVERDUE when its scheduler has missed it for more than this many cadences. */
export const OVERDUE_FACTOR = 1.5;

export type TPollStatus = "idle" | "ok" | "due" | "overdue";

export interface IPollItem {
  id: string;
  phase: string;
  last_seen: string | null;
}

export interface IPollSeen {
  key: string;
  seen_at: string;
  until: string | null;
  note: string | null;
}

export interface IPollRow {
  flow: string;
  poll: string;
  agent: string;
  cadence: string;
  cadence_s: number;
  phases: string[];
  status: TPollStatus;
  /** True for `due` and `overdue`. */
  due: boolean;
  overdue: boolean;
  applies: boolean;
  last_run: string | null;
  next_at: string | null;
  overdue_at: string | null;
  items: IPollItem[];
  seen: IPollSeen[];
}

export interface IPollFilter {
  flow?: string;
  poll?: string;
}

/** Latest pass of `poll` that listed `itemId`, or null. */
export function lastSeen(db: TDatabase, flow: string, poll: string, itemId: string): string | null {
  const row = db
    .query(
      `SELECT MAX(r.ts) AS ts FROM poll_run_items i JOIN poll_runs r ON r.id = i.run_id
       WHERE r.flow = ? AND r.poll = ? AND i.item_id = ?`,
    )
    .get(flow, poll, itemId) as { ts: string | null };
  return row.ts;
}

/** When the item entered its current phase: its last move into it, else its creation. */
export function enteredPhaseAt(
  db: TDatabase,
  item: { id: string; phase: string; created_at: string },
): string {
  const row = db
    .query(
      `SELECT MAX(ts) AS ts FROM events
       WHERE item_id = ? AND kind = 'phase' AND phase = ?
         AND json_extract(data, '$.from') IS NOT ?`,
    )
    .get(item.id, item.phase, item.phase) as { ts: string | null };
  return row.ts ?? item.created_at;
}

/** Seen keys of a poll; the expired ones only with `all`. */
export function activeSeen(
  db: TDatabase,
  flow: string,
  poll: string,
  at: Date,
  all = false,
): IPollSeen[] {
  const rows = db
    .query(
      "SELECT key, seen_at, until, note FROM poll_seen WHERE flow = ? AND poll = ? ORDER BY seen_at, key",
    )
    .all(flow, poll) as IPollSeen[];
  const now = iso(at);
  return rows.filter((r) => all || r.until === null || r.until > now);
}

function lastRun(db: TDatabase, flow: string, poll: string): string | null {
  const row = db
    .query("SELECT MAX(ts) AS ts FROM poll_runs WHERE flow = ? AND poll = ?")
    .get(flow, poll) as { ts: string | null };
  return row.ts;
}

function rowOf(db: TDatabase | null, flowName: string, poll: IPoll, at: Date): IPollRow {
  const now = at.getTime();
  const cadenceMs = poll.cadenceS * 1000;
  let items: IPollItem[] = [];
  let enteredAt: string[] = [];
  let last: string | null = null;
  let seen: IPollSeen[] = [];
  if (db) {
    last = lastRun(db, flowName, poll.name);
    seen = activeSeen(db, flowName, poll.name, at);
    if (poll.phases.length > 0) {
      const marks = poll.phases.map(() => "?").join(", ");
      const open = db
        .query(
          `SELECT id, phase, created_at FROM items
           WHERE flow = ? AND status = 'open' AND phase IN (${marks}) ORDER BY id`,
        )
        .all(flowName, ...poll.phases) as { id: string; phase: string; created_at: string }[];
      items = open.map((o) => ({
        id: o.id,
        phase: o.phase,
        last_seen: lastSeen(db, flowName, poll.name, o.id),
      }));
      enteredAt = open.map((o) => enteredPhaseAt(db, o));
    }
  }
  const applies = poll.phases.length === 0 || items.length > 0;
  const lastMs = last === null ? null : Date.parse(last);
  const entered = enteredAt.length > 0 ? Math.min(...enteredAt.map((t) => Date.parse(t))) : null;
  const sinceMs = lastMs === null ? entered : entered === null ? lastMs : Math.max(lastMs, entered);
  const nextMs = applies ? (lastMs === null ? now : lastMs + cadenceMs) : null;
  const overdueMs = applies && sinceMs !== null ? sinceMs + OVERDUE_FACTOR * cadenceMs : null;
  let status: TPollStatus;
  if (!applies) status = "idle";
  else if (nextMs !== null && now < nextMs) status = "ok";
  else if (overdueMs !== null && now > overdueMs) status = "overdue";
  else status = "due";
  const stamp = (ms: number | null): string | null => (ms === null ? null : iso(new Date(ms)));
  return {
    flow: flowName,
    poll: poll.name,
    agent: poll.agent,
    cadence: poll.cadence,
    cadence_s: poll.cadenceS,
    phases: poll.phases,
    status,
    due: status === "due" || status === "overdue",
    overdue: status === "overdue",
    applies,
    last_run: last,
    next_at: stamp(nextMs),
    overdue_at: stamp(overdueMs),
    items,
    seen,
  };
}

/**
 * Every poll of every active flow, in flow-name then declaration order. A pure reader: the cadence comes from
 * the flow and `last_run` from the passes recorded, so it works without a database and writes nothing.
 */
export function pollRows(
  db: TDatabase | null,
  flows: IFlowSet,
  at: Date,
  filter: IPollFilter = {},
): IPollRow[] {
  const rows: IPollRow[] = [];
  const names = [...flows.entries.keys()].sort();
  for (const name of names) {
    if (filter.flow !== undefined && name !== filter.flow) continue;
    const flow = flows.entries.get(name)?.flow;
    // Flow versions stored before polling existed have no `polling`.
    for (const poll of flow?.polling ?? []) {
      if (filter.poll !== undefined && poll.name !== filter.poll) continue;
      rows.push(rowOf(db, name, poll, at));
    }
  }
  return rows;
}

export function pollLine(row: IPollRow): string {
  const head = `${row.flow}/${row.poll} · ${row.agent} · every ${row.cadence}`;
  const items = `items: ${row.items.map((i) => i.id).join(", ") || "none"}`;
  const last = row.last_run === null ? "never run" : `last ${row.last_run}`;
  switch (row.status) {
    case "idle":
      return `IDLE     ${head} · no open items in ${row.phases.join(", ")}`;
    case "ok":
      return `OK       ${head} · next ${row.next_at}`;
    case "overdue":
      return `OVERDUE  ${row.flow}/${row.poll} · ${row.agent} · every ${row.cadence} · ${items} · ${last} · overdue since ${row.overdue_at}`;
    default:
      return `DUE      ${head} · ${items} · ${last}`;
  }
}
