import { existsSync } from "node:fs";
import {
  type IBoardFlow,
  type IStagePaint,
  paintOf,
  boardFlows as sharedBoardFlows,
} from "../board.ts";
import { now } from "../clock.ts";
import { type IStateItem, listState } from "../commands/state.ts";
import { cronJobs, DEFAULT_HORIZON, type ICronJob, itemCrons } from "../cron.ts";
import { BUSY_TIMEOUT_MS, openDb, SCHEMA_VERSION, type TDatabase, userVersion } from "../db.ts";
import { dbError } from "../errors.ts";
import { type IFlow, parseCadence } from "../flow/parse.ts";
import type { IFlowSet } from "../flow/registry.ts";
import { phaseOf } from "../items.ts";
import { type IPollRow, pollRows } from "../poll.ts";
import { Database } from "../sqlite.ts";

export interface IItemLink {
  label: string;
  url: string;
  /** `id`, or the name of the field whose value matched. */
  source: string;
}

export interface IBoardItem extends IStateItem, IStagePaint {
  column: string;
  stage: string | null;
  links: IItemLink[];
  /** `at` of the item's earliest open cron (the card's clock badge), or null. */
  cron_at: string | null;
}

export interface IYourTurn {
  id: string;
  flow: string;
  title: string | null;
  phase: string;
  next: string | null;
  questions: string[];
  links: IItemLink[];
}

export interface IBoardGate {
  item_id: string;
  flow: string;
  phase: string;
  question: string | null;
  opened_at: string;
  links: IItemLink[];
}

export interface IBoardRun {
  item_id: string;
  flow: string;
  agent: string;
  phase: string;
  handle: string | null;
  started_at: string;
}

/** A poll of the board's footer: `wip poll due`'s row without the seen keys. The server's clock is not in it, so an idle board's text stays equal between requests. */
export type IBoardPoll = Omit<IPollRow, "seen">;

/** A job of the «Scheduled» footer: `wip cron list`'s job without its poll row. */
export type IBoardCron = Omit<ICronJob, "pass">;

export interface IBoard {
  polling: { polls: IBoardPoll[] };
  /** Open crons and the next pass of each flow poll within the default horizon, sorted by time. */
  crons: IBoardCron[];
  flows: IBoardFlow[];
  items: IBoardItem[];
  your_turn: IYourTurn[];
  open_gates: IBoardGate[];
  running: IBoardRun[];
  warnings: { code: string; flow: unknown; message: string }[];
}

/** The database read-only, or `null` while it does not exist; a schema this build does not read is an error. */
export function openReadOnly(path: string): TDatabase | null {
  if (!existsSync(path)) return null;
  const db = new Database(path, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const version = userVersion(db);
    if (version !== SCHEMA_VERSION) {
      throw dbError(
        `the database is at schema ${version}; this wip web reads schema ${SCHEMA_VERSION}`,
      );
    }
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/** Starting the server is the one place the web writes: a database behind this build is migrated like any command would. */
export function migrateIfBehind(path: string): void {
  if (!existsSync(path)) return;
  const probe = new Database(path, { readOnly: true });
  let behind: boolean;
  try {
    probe.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    behind = userVersion(probe) < SCHEMA_VERSION;
  } finally {
    probe.close();
  }
  if (behind) openDb(path).close();
}

function linkValues(id: string, fields: Record<string, unknown>): [string, string][] {
  const values: [string, string][] = [["id", id]];
  for (const [key, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (typeof v === "string" || typeof v === "number") values.push([key, String(v)]);
    }
  }
  return values;
}

/** Every `links` pattern of the flow that matches the ID or a field value, with `$1`… filled in (F-FLU-10). */
export function itemLinks(
  flow: IFlow | null,
  id: string,
  fields: Record<string, unknown>,
): IItemLink[] {
  const out: IItemLink[] = [];
  for (const link of flow?.links ?? []) {
    let re: RegExp;
    try {
      re = new RegExp(link.pattern);
    } catch {
      continue;
    }
    for (const [source, value] of linkValues(id, fields)) {
      const m = re.exec(value);
      if (!m) continue;
      const url = link.url.replace(/\$(\d+)/g, (_, n: string) =>
        encodeURIComponent(m[Number(n)] ?? ""),
      );
      if (!out.some((l) => l.url === url)) out.push({ label: value, url, source });
    }
  }
  return out;
}

/** Absolute http(s) URLs in the item's fields: the panel's Links section shows them (F-WEB-12). */
export function fieldLinks(fields: Record<string, unknown>): IItemLink[] {
  const out: IItemLink[] = [];
  for (const [source, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (typeof v !== "string") continue;
      const text = v.trim();
      let url: URL;
      try {
        url = new URL(text);
      } catch {
        continue;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      if (out.some((l) => l.url === url.href)) continue;
      out.push({ label: text, url: url.href, source });
    }
  }
  return out;
}

function flowOf(flows: IFlowSet, name: string): IFlow | null {
  return flows.entries.get(name)?.flow ?? null;
}

/** The kanban: the same items and signals as `wip state`, «your turn» as `wip state --attention`. */
export function boardData(db: TDatabase | null, flows: IFlowSet): IBoard {
  const open = listState(db, flows);
  const flowsOfBoard = sharedBoardFlows(flows, open);
  const items: IBoardItem[] = open.map((s) => {
    const flow = flowOf(flows, s.flow);
    const column = flowsOfBoard
      .find((f) => f.name === s.flow)
      ?.columns.find((c) => c.phases.includes(s.phase));
    return {
      ...s,
      column: column?.key ?? `phase:${s.phase}`,
      stage: (flow && phaseOf(flow, s.phase)?.stage) ?? null,
      ...paintOf(column),
      links: itemLinks(flow, s.id, s.fields),
      cron_at: itemCrons(db, s.id)[0]?.at ?? null,
    };
  });
  const linksOf = (id: string): IItemLink[] => items.find((i) => i.id === id)?.links ?? [];
  const yourTurn = listState(db, flows, { attention: true }).map((s) => ({
    id: s.id,
    flow: s.flow,
    title: s.title,
    phase: s.phase,
    next: s.next,
    questions: s.open_gates.map((g) => g.question ?? "").filter((q) => q !== ""),
    links: linksOf(s.id),
  }));
  const gates = items
    .flatMap((i) =>
      i.open_gates.map((g) => ({
        item_id: i.id,
        flow: i.flow,
        phase: g.phase,
        question: g.question,
        opened_at: g.opened_at,
        links: i.links,
      })),
    )
    .sort((a, b) => a.opened_at.localeCompare(b.opened_at) || a.item_id.localeCompare(b.item_id));
  const running = items
    .flatMap((i) => i.agents.map((a) => ({ item_id: i.id, flow: i.flow, ...a })))
    .sort((a, b) => a.started_at.localeCompare(b.started_at) || a.item_id.localeCompare(b.item_id));
  const at = now();
  const polls = pollRows(db, flows, at).map(({ seen: _seen, ...row }) => row);
  const horizonS = parseCadence(DEFAULT_HORIZON) as number;
  const crons = cronJobs(db, flows, at, horizonS).data.jobs.map(({ pass: _pass, ...job }) => job);
  return {
    polling: { polls },
    crons,
    flows: flowsOfBoard,
    items,
    your_turn: yourTurn,
    open_gates: gates,
    running,
    warnings: flows.warnings.map((w) => ({ code: w.code, flow: w.flow, message: w.message })),
  };
}
