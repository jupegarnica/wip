import { now, parseIso } from "./clock.ts";
import type { TDatabase } from "./db.ts";

export interface ITotals {
  runs: number;
  running: number;
  /** Seconds: sum of the durations of the finished runs (orphaned runs have none). */
  agent_seconds: number;
  gates: number;
  /** Seconds from each `gate open` to its `gate close`; an open gate counts up to now. */
  user_wait_seconds: number;
  /** Seconds from `created_at` to `archived_at`, or to `at` while the item is open. */
  clock_seconds: number;
  /** Seconds worked: local days with activity, at most 8 h each, the end's day from 08:00. */
  work_seconds: number;
}

/** The day of `end` counts from here: 08:00 local. */
const WORK_DAY_START_HOUR = 8;
/** 8 h per day. */
const WORK_SECONDS_PER_DAY = 8 * 60 * 60;

const seconds = (from: string, to: Date): number =>
  Math.max(0, Math.round((to.getTime() - parseIso(from).getTime()) / 1000));

/** Local calendar day of a date, `YYYY-MM-DD`. */
export function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Seconds worked between `start` and `end`: every local day with activity (plus the day of `start`,
 * which always counts) contributes its overlap with `[start, end]`, capped at 8 h; the day of `end`
 * contributes from 08:00 local. Days without activity contribute nothing.
 */
export function workSeconds(start: Date, end: Date, activeDays: ReadonlySet<string>): number {
  if (end.getTime() <= start.getTime()) return 0;
  const startKey = localDayKey(start);
  const endKey = localDayKey(end);
  const dayMs = WORK_SECONDS_PER_DAY * 1000;
  let total = 0;
  let day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  for (;;) {
    const key = localDayKey(day);
    if (activeDays.has(key) || key === startKey) {
      const from =
        key === endKey
          ? new Date(day.getFullYear(), day.getMonth(), day.getDate(), WORK_DAY_START_HOUR)
          : day;
      const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
      const overlap =
        Math.min(end.getTime(), next.getTime()) - Math.max(start.getTime(), from.getTime());
      total += Math.min(dayMs, Math.max(0, overlap));
    }
    if (key >= endKey) break;
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  }
  return Math.round(total / 1000);
}

export function itemTotals(db: TDatabase, id: string, at: Date = now()): ITotals {
  const runs = db
    .query(
      `SELECT count(*) AS runs, coalesce(sum(status = 'running'), 0) AS running,
              coalesce(sum(duration_s), 0) AS agent_seconds
         FROM agent_runs WHERE item_id = ?`,
    )
    .get(id) as { runs: number; running: number; agent_seconds: number };
  const gates = db.query("SELECT opened_at, closed_at FROM gates WHERE item_id = ?").all(id) as {
    opened_at: string;
    closed_at: string | null;
  }[];
  const userWait = gates.reduce(
    (sum, g) => sum + seconds(g.opened_at, g.closed_at ? parseIso(g.closed_at) : at),
    0,
  );
  const item = db.query("SELECT created_at, archived_at FROM items WHERE id = ?").get(id) as {
    created_at: string;
    archived_at: string | null;
  } | null;
  let clockSeconds = 0;
  let work = 0;
  if (item) {
    const start = parseIso(item.created_at);
    const end = item.archived_at ? parseIso(item.archived_at) : at;
    clockSeconds = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
    // The activity is read here, not from the events the caller trimmed: a total never depends on --log.
    const events = db.query("SELECT ts FROM events WHERE item_id = ?").all(id) as { ts: string }[];
    work = workSeconds(start, end, new Set(events.map((e) => localDayKey(parseIso(e.ts)))));
  }
  return {
    ...runs,
    gates: gates.length,
    user_wait_seconds: userWait,
    clock_seconds: clockSeconds,
    work_seconds: work,
  };
}
