import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { now } from "../clock.ts";
import { type IStateItem, listState } from "../commands/state.ts";
import { BUSY_TIMEOUT_MS, openDb, SCHEMA_VERSION, type TDatabase, userVersion } from "../db.ts";
import { dbError } from "../errors.ts";
import type { IFlow } from "../flow/parse.ts";
import type { IFlowSet, TFlowSource } from "../flow/registry.ts";
import { phaseOf } from "../items.ts";
import { type IPollRow, pollRows } from "../poll.ts";

export interface IItemLink {
  label: string;
  url: string;
  /** `id`, or the name of the field whose value matched. */
  source: string;
}

/** A column without a stage has no colour: `alpha` null and empty strings. */
export interface IStagePaint {
  alpha: number | null;
  /** CSS `rgba()`. */
  color: string;
  /** Text on `color` in the light theme. */
  text: string;
  /** Text on `color` in the dark theme. */
  text_dark: string;
}

export const NO_PAINT: IStagePaint = { alpha: null, color: "", text: "", text_dark: "" };

export function stagePaint(alpha: number, tone: string = STAGE_TONE): IStagePaint {
  return {
    alpha,
    color: stageColor(alpha, tone),
    text: textOn(composite(tone, alpha, SURFACE_LIGHT)),
    text_dark: textOn(composite(tone, alpha, SURFACE_DARK)),
  };
}

export function paintOf(column: IStagePaint | undefined): IStagePaint {
  if (!column) return { ...NO_PAINT };
  const { alpha, color, text, text_dark } = column;
  return { alpha, color, text, text_dark };
}

export interface IColumn extends IStagePaint {
  key: string;
  label: string;
  stage: string | null;
  phases: string[];
}

export interface IBoardFlow {
  name: string;
  source: TFlowSource;
  columns: IColumn[];
}

export interface IBoardItem extends IStateItem, IStagePaint {
  column: string;
  stage: string | null;
  links: IItemLink[];
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

export interface IBoard {
  polling: { polls: IBoardPoll[] };
  flows: IBoardFlow[];
  items: IBoardItem[];
  your_turn: IYourTurn[];
  open_gates: IBoardGate[];
  running: IBoardRun[];
  warnings: { code: string; flow: unknown; message: string }[];
}

/** Default tone of a flow without `color`; each stage is more transparent the later it comes in the flow. */
export const STAGE_TONE = "#2563EB";
export const STAGE_ALPHA_FIRST = 1;
export const STAGE_ALPHA_LAST = 0.25;
/** `--surface` of each theme in web/app.css: the stage colour is composited over it to choose the text. */
export const SURFACE_LIGHT = "#FFFFFF";
export const SURFACE_DARK = "#211F1D";
const DARK_TEXT = "#111111";
const LIGHT_TEXT = "#FFFFFF";

/** Opacity of the stage at `index` of `count`: the first one opaque, the last one at `STAGE_ALPHA_LAST`. */
export function stageAlpha(index: number, count: number): number {
  if (count <= 1) return STAGE_ALPHA_FIRST;
  const step = (STAGE_ALPHA_FIRST - STAGE_ALPHA_LAST) / (count - 1);
  return Math.round((STAGE_ALPHA_FIRST - step * index) * 100) / 100;
}

function rgbOf(hex: string): [number, number, number] {
  const at = (i: number): number => Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  return [at(0), at(1), at(2)];
}

export function stageColor(alpha: number, tone: string = STAGE_TONE): string {
  const [r, g, b] = rgbOf(tone);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** The solid colour `tone` at `alpha` shows over `surface`. */
export function composite(tone: string, alpha: number, surface: string): string {
  const under = rgbOf(surface);
  const mixed = rgbOf(tone).map((c, i) =>
    Math.round(c * alpha + (under[i] as number) * (1 - alpha)),
  );
  return `#${mixed.map((c) => c.toString(16).padStart(2, "0").toUpperCase()).join("")}`;
}

function luminance(hex: string): number {
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgbOf(hex).map(channel) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Dark or white text, whichever has the higher WCAG contrast on `hex`. */
export function textOn(hex: string): string {
  const l = luminance(hex);
  const onDark = (luminance(LIGHT_TEXT) + 0.05) / (l + 0.05);
  const onLight = (l + 0.05) / (luminance(DARK_TEXT) + 0.05);
  return onDark >= onLight ? LIGHT_TEXT : DARK_TEXT;
}

/** The database read-only, or `null` while it does not exist; a schema this build does not read is an error. */
export function openReadOnly(path: string): TDatabase | null {
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true, strict: true });
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
  const probe = new Database(path, { readonly: true, strict: true });
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

/**
 * One column per `stage`, in the order each stage first appears; a phase without a stage is its own column.
 * Phases of live items that the flow lacks go last, one column each.
 */
export function flowColumns(flow: IFlow | null, extraPhases: readonly string[] = []): IColumn[] {
  const columns: IColumn[] = [];
  const add = (key: string, label: string, stage: string | null, phase: string): void => {
    const found = columns.find((c) => c.key === key);
    if (found) found.phases.push(phase);
    else columns.push({ key, label, stage, phases: [phase], ...NO_PAINT });
  };
  for (const p of flow?.phases ?? []) {
    if (p.stage) add(`stage:${p.stage}`, p.stage, p.stage, p.name);
    else add(`phase:${p.name}`, p.name, null, p.name);
  }
  for (const name of extraPhases) {
    if (!columns.some((c) => c.phases.includes(name))) add(`phase:${name}`, name, null, name);
  }
  const staged = columns.filter((c) => c.stage !== null);
  const tone = flow?.color ?? STAGE_TONE;
  staged.forEach((c, i) => {
    Object.assign(c, stagePaint(stageAlpha(i, staged.length), tone));
  });
  return columns;
}

function flowOf(flows: IFlowSet, name: string): IFlow | null {
  return flows.entries.get(name)?.flow ?? null;
}

/** The kanban: the same items and signals as `wip state`, «your turn» as `wip state --attention`. */
export function boardData(db: TDatabase | null, flows: IFlowSet): IBoard {
  const open = listState(db, flows);
  const names = [...new Set([...flows.entries.keys(), ...open.map((i) => i.flow)])].sort();
  const boardFlows: IBoardFlow[] = names.map((name) => {
    const used = [...new Set(open.filter((i) => i.flow === name).map((i) => i.phase))];
    return {
      name,
      source: flows.entries.get(name)?.source ?? null,
      columns: flowColumns(flowOf(flows, name), used),
    };
  });
  const items: IBoardItem[] = open.map((s) => {
    const flow = flowOf(flows, s.flow);
    const column = boardFlows
      .find((f) => f.name === s.flow)
      ?.columns.find((c) => c.phases.includes(s.phase));
    return {
      ...s,
      column: column?.key ?? `phase:${s.phase}`,
      stage: (flow && phaseOf(flow, s.phase)?.stage) ?? null,
      ...paintOf(column),
      links: itemLinks(flow, s.id, s.fields),
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
  const polls = pollRows(db, flows, now()).map(({ seen: _seen, ...row }) => row);
  return {
    polling: { polls },
    flows: boardFlows,
    items,
    your_turn: yourTurn,
    open_gates: gates,
    running,
    warnings: flows.warnings.map((w) => ({ code: w.code, flow: w.flow, message: w.message })),
  };
}
