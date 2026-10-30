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
}

const seconds = (from: string, to: Date): number =>
  Math.max(0, Math.round((to.getTime() - parseIso(from).getTime()) / 1000));

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
  return { ...runs, gates: gates.length, user_wait_seconds: userWait };
}
