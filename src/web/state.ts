import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { type IStateItem, listState } from "../commands/state.ts";
import { BUSY_TIMEOUT_MS, SCHEMA_VERSION, type TDatabase, userVersion } from "../db.ts";
import { dbError } from "../errors.ts";
import type { IFlow } from "../flow/parse.ts";
import type { IFlowSet, TFlowSource } from "../flow/registry.ts";
import { phaseOf } from "../items.ts";

export interface IItemLink {
  label: string;
  url: string;
  /** `id`, or the name of the field whose value matched. */
  source: string;
}

export interface IColumn {
  key: string;
  label: string;
  stage: string | null;
  phases: string[];
  color: string;
  text: string;
}

export interface IBoardFlow {
  name: string;
  source: TFlowSource;
  columns: IColumn[];
}

export interface IBoardItem extends IStateItem {
  column: string;
  stage: string | null;
  color: string;
  text: string;
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

export interface IBoard {
  flows: IBoardFlow[];
  items: IBoardItem[];
  your_turn: IYourTurn[];
  open_gates: IBoardGate[];
  running: IBoardRun[];
  warnings: { code: string; flow: unknown; message: string }[];
}

/** By column order inside each flow, the same for every flow. */
export const PALETTE: readonly string[] = [
  "#4C6EF5",
  "#12B886",
  "#FAB005",
  "#E64980",
  "#7950F2",
  "#15AABF",
  "#FD7E14",
  "#82C91E",
];
export const FALLBACK_COLOR = "#ADB5BD";

/** Black or white, whichever reads better on `hex` (WCAG relative luminance). */
export function textOn(hex: string): string {
  const channel = (i: number): number => {
    const c = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  return l > 0.4 ? "#111111" : "#FFFFFF";
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
    else columns.push({ key, label, stage, phases: [phase], color: "", text: "" });
  };
  for (const p of flow?.phases ?? []) {
    if (p.stage) add(`stage:${p.stage}`, p.stage, p.stage, p.name);
    else add(`phase:${p.name}`, p.name, null, p.name);
  }
  for (const name of extraPhases) {
    if (!columns.some((c) => c.phases.includes(name))) add(`phase:${name}`, name, null, name);
  }
  columns.forEach((c, i) => {
    c.color = flow ? (PALETTE[i % PALETTE.length] as string) : FALLBACK_COLOR;
    c.text = textOn(c.color);
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
      color: column?.color ?? FALLBACK_COLOR,
      text: column?.text ?? textOn(FALLBACK_COLOR),
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
  return {
    flows: boardFlows,
    items,
    your_turn: yourTurn,
    open_gates: gates,
    running,
    warnings: flows.warnings.map((w) => ({ code: w.code, flow: w.flow, message: w.message })),
  };
}
