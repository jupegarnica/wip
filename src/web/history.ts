import type { TDatabase } from "../db.ts";
import type { IFlow } from "../flow/parse.ts";
import { FLOW_NAME_RE } from "../flow/parse.ts";
import type { IFlowSet } from "../flow/registry.ts";
import { type IItemRow, itemFields, terminalPhase } from "../items.ts";
import { flowColumns, type IItemLink, type IStagePaint, itemLinks, paintOf } from "./state.ts";

/** active: open, any phase · archived: archived in its flow's terminal phase · discarded: archived elsewhere. */
export type TCategory = "active" | "archived" | "discarded";

export const CATEGORIES: readonly TCategory[] = ["active", "archived", "discarded"];
export const DEFAULT_INCLUDE: readonly TCategory[] = ["active", "archived"];
export const HISTORY_LIMIT = 50;
export const HISTORY_MAX_LIMIT = 200;
const MAX_QUERY = 100;

/** Only an active item carries its stage's colour. */
export interface IHistoryItem extends IStagePaint {
  id: string;
  flow: string;
  title: string | null;
  phase: string;
  status: "open" | "archived";
  category: TCategory;
  /** `archived_at` when archived; `updated_at` (last activity) when open. */
  date: string;
  links: IItemLink[];
}

export interface IHistoryQuery {
  flow?: string;
  q?: string;
  include?: TCategory[];
  limit?: number;
  offset?: number;
}

export interface IHistoryPage {
  total: number;
  offset: number;
  limit: number;
  /** Flows with at least one item, sorted: the page's flow filter. */
  flows: string[];
  items: IHistoryItem[];
}

export function categoryOf(
  item: Pick<IItemRow, "status" | "phase">,
  flow: IFlow | null,
): TCategory {
  if (item.status === "open") return "active";
  const terminal = flow ? terminalPhase(flow) : undefined;
  if (!terminal) return "archived";
  return item.phase === terminal.name ? "archived" : "discarded";
}

export function historyData(
  db: TDatabase | null,
  flows: IFlowSet,
  query: IHistoryQuery = {},
): IHistoryPage {
  const rows = (db ? (db.query("SELECT * FROM items ORDER BY id").all() as IItemRow[]) : []).filter(
    (item) => !flows.disabled.has(item.flow),
  );
  const all: IHistoryItem[] = rows.map((item) => {
    const flow = flows.entries.get(item.flow)?.flow ?? null;
    const category = categoryOf(item, flow);
    const column = flowColumns(flow, [item.phase]).find((c) => c.phases.includes(item.phase));
    return {
      id: item.id,
      flow: item.flow,
      title: item.title,
      phase: item.phase,
      status: item.status,
      category,
      date: (item.status === "archived" ? item.archived_at : null) ?? item.updated_at,
      ...paintOf(category === "active" ? column : undefined),
      links: itemLinks(flow, item.id, itemFields(item)),
    };
  });
  all.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  const wanted = new Set(query.include?.length ? query.include : DEFAULT_INCLUDE);
  const needle = (query.q ?? "").toLowerCase();
  const matching = all.filter(
    (h) =>
      wanted.has(h.category) &&
      (!query.flow || h.flow === query.flow) &&
      (!needle ||
        h.id.toLowerCase().includes(needle) ||
        (h.title ?? "").toLowerCase().includes(needle)),
  );
  const limit = query.limit ?? HISTORY_LIMIT;
  const offset = query.offset ?? 0;
  return {
    total: matching.length,
    offset,
    limit,
    flows: [...new Set(all.map((h) => h.flow))].sort(),
    items: matching.slice(offset, offset + limit),
  };
}

/** The query of /api/history, or the text of a 400. Empty values are absent; unknown keys are ignored. */
export function parseHistoryQuery(params: URLSearchParams): IHistoryQuery | string {
  const out: IHistoryQuery = {};
  const flow = params.get("flow");
  if (flow) {
    if (!FLOW_NAME_RE.test(flow) || flow.length > 64) return "invalid flow";
    out.flow = flow;
  }
  const q = params.get("q")?.trim();
  if (q) {
    if (q.length > MAX_QUERY) return `q is longer than ${MAX_QUERY} characters`;
    out.q = q;
  }
  const include = (params.get("include") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (include.length > 0) {
    if (!include.every((w) => (CATEGORIES as readonly string[]).includes(w))) {
      return `include takes ${CATEGORIES.join(", ")}, comma-separated`;
    }
    out.include = [...new Set(include as TCategory[])];
  }
  for (const key of ["limit", "offset"] as const) {
    const raw = params.get(key);
    if (!raw) continue;
    if (!/^\d{1,6}$/.test(raw)) return `${key} must be an integer ≥ 0`;
    const n = Number(raw);
    if (key === "limit" && (n < 1 || n > HISTORY_MAX_LIMIT)) {
      return `limit between 1 and ${HISTORY_MAX_LIMIT}`;
    }
    out[key] = n;
  }
  return out;
}
