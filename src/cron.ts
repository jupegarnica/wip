import { iso } from "./clock.ts";
import type { TDatabase } from "./db.ts";
import { notFound, usage } from "./errors.ts";
import type { IFlowSet } from "./flow/registry.ts";
import { type IPollRow, pollRows } from "./poll.ts";
import { localMinute } from "./when.ts";

/** A job is due this many seconds before its time: a runtime one-shot can fire up to 90 s early. */
export const GRACE_S = 120;
export const DEFAULT_HORIZON = "7d";
export const TEXT_MAX = 500;

export type TCronKind = "reminder" | "poll";
export type TCronStatus = "open" | "done" | "cancelled";

export interface ICronRow {
  id: number;
  kind: TCronKind;
  text: string | null;
  flow: string | null;
  poll: string | null;
  at: string;
  every: string | null;
  item_id: string | null;
  status: TCronStatus;
  created_at: string;
  closed_at: string | null;
}

export interface ICronJob {
  /** Stable while nothing changes: `cron:c<id>@<at>` or `poll:<flow>/<poll>@<next_at>`. */
  key: string;
  kind: TCronKind;
  /** `cron`: stored with `wip cron add` · `flow`: the next pass of a flow poll. */
  source: "cron" | "flow";
  id: string | null;
  status: TCronStatus;
  at: string;
  at_local: string;
  /** A 5-field expression for the local minute of `at`. */
  cron: string;
  due: boolean;
  missed: boolean;
  every: string | null;
  text: string | null;
  item: string | null;
  flow: string | null;
  poll: string | null;
  agent: string | null;
  /** For `kind: poll`: the `wip poll due` row of its poll. */
  pass: IPollRow | null;
}

export interface IRearm {
  key: "rearm";
  at: string;
  at_local: string;
  cron: string;
}

export interface ICronList {
  now: string;
  session: string | null;
  horizon_end: string;
  beyond: number;
  rearm: IRearm | null;
  jobs: ICronJob[];
}

export interface ISession {
  id: string;
  started_at: string;
}

export const cronId = (row: { id: number }): string => `c${row.id}`;

/** `c3` (or `3`) → 3; exit 2 for anything else. */
export function parseCronId(raw: string | undefined): number {
  const m = raw === undefined ? null : /^c?([1-9][0-9]*)$/.exec(raw);
  if (!m) throw usage(`a cron id: c<N> (got '${raw ?? ""}')`);
  return Number(m[1]);
}

export function getCron(db: TDatabase, id: number): ICronRow {
  const row = db.query("SELECT * FROM crons WHERE id = ?").get(id) as ICronRow | null;
  if (!row) throw notFound(`cron not found: c${id}`);
  return row;
}

/** The session that has not ended (the latest one), or null. */
export function openSession(db: TDatabase | null): ISession | null {
  if (!db) return null;
  return db
    .query(
      "SELECT id, started_at FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC, id DESC LIMIT 1",
    )
    .get() as ISession | null;
}

/** Whether `at` is due at `now`, with the grace. */
export function isDue(at: string, now: Date): boolean {
  return Date.parse(at) <= now.getTime() + GRACE_S * 1000;
}

function missedOf(due: boolean, at: string, session: ISession | null): boolean {
  if (!due) return false;
  return session === null || at < session.started_at;
}

export interface IJobBase {
  key: string;
  kind: TCronKind;
  source: "cron" | "flow";
  id: string | null;
  status: TCronStatus;
  at: string;
  every: string | null;
  text: string | null;
  item: string | null;
  flow: string | null;
  poll: string | null;
  agent: string | null;
  pass: IPollRow | null;
}

export function makeJob(base: IJobBase, now: Date, session: ISession | null): ICronJob {
  const { at_local, cron } = localMinute(new Date(base.at));
  const due = base.status === "open" && isDue(base.at, now);
  return {
    key: base.key,
    kind: base.kind,
    source: base.source,
    id: base.id,
    status: base.status,
    at: base.at,
    at_local,
    cron,
    due,
    missed: missedOf(due, base.at, session),
    every: base.every,
    text: base.text,
    item: base.item,
    flow: base.flow,
    poll: base.poll,
    agent: base.agent,
    pass: base.pass,
  };
}

/** A stored cron as a job; `pass` and `agent` come from its poll when it has one. */
export function cronJob(
  row: ICronRow,
  now: Date,
  session: ISession | null,
  poll: { agent: string; pass: IPollRow } | null = null,
): ICronJob {
  return makeJob(
    {
      key: `cron:${cronId(row)}@${row.at}`,
      kind: row.kind,
      source: "cron",
      id: cronId(row),
      status: row.status,
      at: row.at,
      every: row.every,
      text: row.text,
      item: row.item_id,
      flow: row.flow,
      poll: row.poll,
      agent: poll?.agent ?? null,
      pass: poll?.pass ?? null,
    },
    now,
    session,
  );
}

export function cronRows(db: TDatabase | null, all = false): ICronRow[] {
  if (!db) return [];
  const where = all ? "" : "WHERE status = 'open'";
  return db.query(`SELECT * FROM crons ${where} ORDER BY at, id`).all() as ICronRow[];
}

/** Open crons of one item, earliest first. */
export function itemCrons(db: TDatabase | null, itemId: string): ICronRow[] {
  if (!db) return [];
  return db
    .query("SELECT * FROM crons WHERE item_id = ? AND status = 'open' ORDER BY at, id")
    .all(itemId) as ICronRow[];
}

export interface ICronListResult {
  data: ICronList;
  /** Stored poll crons whose flow or poll is not active: listed in text, left out of `jobs`. */
  inactive: { row: ICronRow; why: string }[];
}

/** `rearm` lies one seventh of the horizon before its end (6 days for 7), on a whole minute. */
function rearmAt(now: Date, horizonS: number): Date {
  const ms = now.getTime() + Math.floor((horizonS * 1000 * 6) / 7);
  return new Date(ms - (ms % 60_000));
}

/**
 * What `wip cron list` reports: open crons (every one with `all`) and the next pass of each flow poll, sorted by
 * time. A pure reader.
 */
export function cronJobs(
  db: TDatabase | null,
  flows: IFlowSet,
  now: Date,
  horizonS: number,
  all = false,
): ICronListResult {
  const session = openSession(db);
  const horizonEnd = new Date(now.getTime() + horizonS * 1000);
  const end = iso(horizonEnd);
  const jobs: ICronJob[] = [];
  const inactive: { row: ICronRow; why: string }[] = [];
  let beyond = 0;
  const keep = (job: ICronJob): void => {
    if (job.status === "open" && job.at > end) beyond++;
    else jobs.push(job);
  };
  const polls = pollRows(db, flows, now);
  const pollOf = (flow: string | null, poll: string | null): IPollRow | undefined =>
    polls.find((r) => r.flow === flow && r.poll === poll);
  for (const row of cronRows(db, all)) {
    if (row.kind === "reminder") {
      keep(cronJob(row, now, session));
      continue;
    }
    const pass = pollOf(row.flow, row.poll);
    if (pass) {
      keep(cronJob(row, now, session, { agent: pass.agent, pass }));
    } else if (row.status === "open") {
      const why = flows.disabled.has(row.flow ?? "") ? "flow disabled" : "poll not found";
      inactive.push({ row, why });
    }
  }
  // The next pass of each flow poll; an idle one (no open item in its phases) has none.
  for (const pass of polls) {
    if (pass.next_at === null) continue;
    keep(
      makeJob(
        {
          key: `poll:${pass.flow}/${pass.poll}@${pass.next_at}`,
          kind: "poll",
          source: "flow",
          id: null,
          status: "open",
          at: pass.next_at,
          every: pass.cadence,
          text: null,
          item: null,
          flow: pass.flow,
          poll: pass.poll,
          agent: pass.agent,
          pass,
        },
        now,
        session,
      ),
    );
  }
  jobs.sort((a, b) => (a.at === b.at ? a.key.localeCompare(b.key) : a.at < b.at ? -1 : 1));
  let rearm: IRearm | null = null;
  if (beyond > 0) {
    const at = rearmAt(now, horizonS);
    const { at_local, cron } = localMinute(at);
    rearm = { key: "rearm", at: iso(at), at_local, cron };
  }
  return {
    data: { now: iso(now), session: session?.id ?? null, horizon_end: end, beyond, rearm, jobs },
    inactive,
  };
}

/** One line of `wip cron list`. */
export function jobLine(job: ICronJob): string {
  const tag =
    job.status !== "open"
      ? job.status.toUpperCase()
      : job.missed
        ? "MISSED"
        : job.due
          ? "DUE"
          : "OPEN";
  const what =
    job.kind === "reminder"
      ? `${job.id} · ${job.text}`
      : job.source === "cron"
        ? `${job.id} · poll ${job.flow}/${job.poll}${job.text ? ` · ${job.text}` : ""}`
        : `${job.flow}/${job.poll} · next pass`;
  const every = job.every ? ` · every ${job.every}` : "";
  const item = job.item ? ` · item ${job.item}` : "";
  return `${tag.padEnd(9)} ${job.at_local} · ${what}${every}${item}`;
}
