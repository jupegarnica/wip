import { type IArgs, need } from "../args.ts";
import { iso, now } from "../clock.ts";
import type { ICtx, IHandler } from "../context.ts";
import {
  cronJob,
  cronJobs,
  DEFAULT_HORIZON,
  getCron,
  type ICronJob,
  type ICronRow,
  jobLine,
  openSession,
  parseCronId,
  TEXT_MAX,
} from "../cron.ts";
import type { TDatabase } from "../db.ts";
import { notFound, rejected, usage } from "../errors.ts";
import { parseCadence } from "../flow/parse.ts";
import { disabledMessage, loadFlows } from "../flow/registry.ts";
import { getItem } from "../items.ts";
import { type IPollRow, pollRows } from "../poll.ts";
import { advance, localMinute, parseEvery, parseWhen } from "../when.ts";
import { noExtra } from "./phase.ts";

/** Options each sub-command takes; `allow` in cli.ts only knows the ones of `wip cron` as a whole. */
const OPTIONS: Readonly<Record<string, readonly string[]>> = {
  add: ["at", "every", "item", "poll"],
  list: ["horizon", "all"],
  done: [],
  cancel: [],
  snooze: ["at"],
};

function only(args: IArgs): void {
  const sub = args.pos[0] ?? "";
  const ok = new Set([...(OPTIONS[sub] ?? []), "json"]);
  for (const key of [...Object.keys(args.opts), ...args.flags]) {
    if (!ok.has(key)) throw usage(`wip cron ${sub} takes no --${key}`);
  }
}

function textOf(raw: string): string {
  if (raw.trim() === "" || raw.length > TEXT_MAX || /[\r\n]/.test(raw)) {
    throw usage(`the text is one line of 1 to ${TEXT_MAX} characters`);
  }
  return raw;
}

/** The line every write prints: id, local time with its weekday, what it is. */
function writeLine(verb: string, job: ICronJob): string {
  const { weekday } = localMinute(new Date(job.at));
  const what =
    job.kind === "reminder"
      ? job.text
      : `poll ${job.flow}/${job.poll}${job.text ? ` · ${job.text}` : ""}`;
  const every = job.every ? ` · every ${job.every}` : "";
  const item = job.item ? ` · item ${job.item}` : "";
  return `${verb} ${job.id} · ${weekday} ${job.at_local} · ${what}${every}${item}`;
}

function result(ctx: ICtx, db: TDatabase, row: ICronRow, verb: string): void {
  const at = now();
  let poll: { agent: string; pass: IPollRow } | null = null;
  if (row.kind === "poll" && row.flow !== null) {
    const set = loadFlows(ctx.root, db, { write: true });
    const pass = pollRows(db, set, at, { flow: row.flow, poll: row.poll ?? "" })[0];
    if (pass) poll = { agent: pass.agent, pass };
  }
  const job = cronJob(row, at, openSession(db), poll);
  ctx.result.data = { cron: job };
  ctx.result.lines.push(writeLine(verb, job));
}

/** `<flow>/<poll>` of an active flow: exit 4 for an unknown or disabled flow and an unknown poll. */
function pollTarget(ctx: ICtx, raw: string): { flow: string; poll: string } {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(raw);
  if (!m) throw usage(`--poll '${raw}': <flow>/<poll>`);
  const [, flowName, pollName] = m as unknown as [string, string, string];
  const set = loadFlows(ctx.root, ctx.db, { write: true });
  if (set.disabled.has(flowName)) throw notFound(disabledMessage(flowName));
  const entry = set.entries.get(flowName);
  if (!entry?.flow) throw notFound(`flow not found: ${flowName}`);
  const polls = entry.flow.polling ?? [];
  if (!polls.some((p) => p.name === pollName)) {
    throw notFound(
      `poll not found: ${flowName}/${pollName} (polls: ${polls.map((p) => p.name).join(", ") || "none"})`,
    );
  }
  return { flow: flowName, poll: pollName };
}

function add(ctx: ICtx, args: IArgs): void {
  noExtra(args, 2);
  const at = now();
  const isPoll = args.opts.poll !== undefined;
  if (isPoll && args.opts.item !== undefined)
    throw usage("--item goes with a reminder, not --poll");
  const rawText = args.pos[1];
  const text = isPoll
    ? rawText === undefined
      ? null
      : textOf(rawText)
    : textOf(need(rawText, 'the text: wip cron add "<text>" --at <when>'));
  const when = parseWhen(need(args.opts.at, "--at <when>"), at);
  const every = args.opts.every === undefined ? null : parseEvery(args.opts.every);
  const db = ctx.db;
  const target = isPoll ? pollTarget(ctx, args.opts.poll as string) : null;
  let itemId: string | null = null;
  if (args.opts.item !== undefined) {
    const item = getItem(db, args.opts.item);
    if (item.status === "archived") throw rejected(`${item.id} is archived`);
    itemId = item.id;
  }
  const row = db
    .query(
      `INSERT INTO crons (kind, text, flow, poll, at, every, item_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      isPoll ? "poll" : "reminder",
      text,
      target?.flow ?? null,
      target?.poll ?? null,
      iso(when),
      every,
      itemId,
      iso(at),
    ) as ICronRow;
  result(ctx, db, row, "added");
}

function list(ctx: ICtx, args: IArgs): void {
  noExtra(args, 1);
  const raw = args.opts.horizon ?? DEFAULT_HORIZON;
  const horizonS = parseCadence(raw);
  if (horizonS === null) throw usage(`--horizon '${raw}': a number and m, h or d (12h, 7d)`);
  const db = ctx.readDb;
  const flows = loadFlows(ctx.root, db);
  ctx.result.warnings.push(...flows.warnings);
  const { data, inactive } = cronJobs(db, flows, now(), horizonS, args.flags.has("all"));
  ctx.result.data = data;
  for (const job of data.jobs) ctx.result.lines.push(jobLine(job));
  for (const { row, why } of inactive) {
    ctx.result.lines.push(`${"OPEN".padEnd(9)} c${row.id} · poll ${row.flow}/${row.poll} (${why})`);
    ctx.result.warnings.push({
      code: "cron_poll_inactive",
      message: `c${row.id} names ${row.flow}/${row.poll}, which is not active (${why}): it is left out of jobs`,
      id: `c${row.id}`,
    });
  }
  if (data.jobs.length === 0 && inactive.length === 0 && data.beyond === 0) {
    ctx.result.lines.push("nothing scheduled");
  }
  if (data.beyond > 0) {
    ctx.result.lines.push(
      `${data.beyond} more after ${localMinute(new Date(data.horizon_end)).at_local} (rearm ${data.rearm?.at_local})`,
    );
  }
}

/** The cron a `done`, `cancel` or `snooze` changes: it must exist (exit 4) and be open (exit 3). */
function openCron(ctx: ICtx, args: IArgs): ICronRow {
  const id = parseCronId(args.pos[1]);
  noExtra(args, 2);
  const row = getCron(ctx.db, id);
  if (row.status !== "open") throw rejected(`c${id} is ${row.status}`);
  return row;
}

function done(ctx: ICtx, args: IArgs): void {
  const row = openCron(ctx, args);
  const at = now();
  const db = ctx.db;
  if (row.every === null) {
    db.query("UPDATE crons SET status = 'done', closed_at = ? WHERE id = ?").run(iso(at), row.id);
  } else {
    const next = advance(new Date(row.at), row.every, at);
    db.query("UPDATE crons SET at = ? WHERE id = ?").run(iso(next), row.id);
  }
  result(ctx, db, getCron(db, row.id), row.every === null ? "done" : "next");
}

function cancel(ctx: ICtx, args: IArgs): void {
  const row = openCron(ctx, args);
  const db = ctx.db;
  db.query("UPDATE crons SET status = 'cancelled', closed_at = ? WHERE id = ?").run(
    iso(now()),
    row.id,
  );
  result(ctx, db, getCron(db, row.id), "cancelled");
}

function snooze(ctx: ICtx, args: IArgs): void {
  const when = parseWhen(need(args.opts.at, "--at <when>"), now());
  const row = openCron(ctx, args);
  const db = ctx.db;
  db.query("UPDATE crons SET at = ? WHERE id = ?").run(iso(when), row.id);
  result(ctx, db, getCron(db, row.id), "snoozed");
}

/** `list` reads; `add`, `done`, `cancel` and `snooze` write. cli.ts picks the handler by sub-command. */
const checked =
  (run: (ctx: ICtx, args: IArgs) => void) =>
  (ctx: ICtx, args: IArgs): void => {
    only(args);
    run(ctx, args);
  };

export const CRON_HANDLERS: Readonly<Record<string, IHandler>> = {
  add: { db: "write", run: checked(add) },
  list: { db: "read", run: checked(list) },
  done: { db: "write", run: checked(done) },
  cancel: { db: "write", run: checked(cancel) },
  snooze: { db: "write", run: checked(snooze) },
};

export const cronCmd: IHandler = {
  db: "none",
  run: () => {
    throw usage("usage: wip cron add | list | done | cancel | snooze (run `wip cron --help`)");
  },
};
