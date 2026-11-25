import type { EngineInterface, Register, UiOpenResult } from "claude-code";
import { atom, read, update } from "claude-code";

import type {
  TKanbanColumn,
  TKanbanFlow,
  TKanbanItem,
  TKanbanSnapshot,
  TKanbanWeb,
} from "../types";

const PANE_ID = "wip-kanban";
const PANE_TITLE = "wip Kanban";
const PANE_COLUMNS = 48;
const PANE_ROWS = 16;
const HIDDEN_KEY = "hidden-flows-v1";
const TICK_MS = 5000;
const TIMEOUT_MS = 4000;
const ERROR_MAX = 200;
const DEFAULT_WEB_URL = "http://localhost:33333/";
/** Reading `wip web status` on every tick would cost a process every five seconds; every third is about 15 s. */
const WEB_REFRESH_TICKS = 3;
/** The flow filter's glyphs: a fisheye when the flow is shown, a crossed circle when it is hidden. */
const SHOWN_MARK = "\u{25C9}";
const HIDDEN_MARK = "\u{2298}";
/** What the reply says when the engine declines the pane and gives no reason of its own. */
const UNPLACED_FALLBACK = "the app did not place it";

/** The fallback of a row without a stage that also needs attention: the web's amber background. */
const ATTENTION_LIGHT = { background: "#FFF1D6", text: "#111111" } as const;
const ATTENTION_DARK = { background: "#352612", text: "#FFFFFF" } as const;

const EMPTY: TKanbanSnapshot = { items: [], flows: [], error: null, lastGoodAt: null };

const snapshot = atom({ plugin: "wip-kanban", key: "snapshot" } as const, EMPTY, {
  shape: "snapshot-1",
});
const hiddenFlows = atom({ plugin: "wip-kanban", key: "hiddenFlows" } as const, [] as string[], {
  shape: "hidden-flows-1",
});
const web = atom(
  { plugin: "wip-kanban", key: "web" } as const,
  { url: null, lan: null, at: null } as TKanbanWeb,
  { shape: "web-2" },
);

/** The project the session runs in: the key of the hidden flows in `$.store`. */
let sessionRoot: string | null = null;
/** One read at a time: a tick that finds the previous one running is skipped. */
let inFlight = false;
/** One `wip web status` at a time, apart from the board read: neither waits for the other. */
let webInFlight = false;
/** Whether the pane the engine opened unasked was left unplaced, waiting for a person to ask for it. */
let paneUnplaced = false;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

const stringsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** The reason an unplaced pane waits: the engine's own, or `UNPLACED_FALLBACK` when it gave none. */
function unplacedReason(opened: unknown): string {
  const reason = isRecord(opened) ? opened.reason : undefined;
  return typeof reason === "string" && reason.trim() !== "" ? reason.trim() : UNPLACED_FALLBACK;
}

/** One line, at most `ERROR_MAX` characters: what the pane shows of a failure. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > ERROR_MAX ? `${flat.slice(0, ERROR_MAX - 1)}…` : flat;
}

function columnsOf(raw: unknown): TKanbanColumn[] {
  if (!Array.isArray(raw)) return [];
  const out: TKanbanColumn[] = [];
  for (const c of raw) {
    if (!isRecord(c) || typeof c.key !== "string") continue;
    out.push({
      key: c.key,
      label: typeof c.label === "string" ? c.label : c.key,
      stage: typeof c.stage === "string" ? c.stage : null,
      phases: stringsOf(c.phases),
      alpha: typeof c.alpha === "number" ? c.alpha : null,
      color: textOf(c.color),
      color_light: textOf(c.color_light),
      color_dark: textOf(c.color_dark),
      text: textOf(c.text),
      text_dark: textOf(c.text_dark),
    });
  }
  return out;
}

interface IParsed {
  items: TKanbanItem[];
  flows: TKanbanFlow[];
}

/** What `wip state --json` must satisfy; anything else is the error of this pass, never an invented board. */
function parseState(body: unknown): IParsed | string {
  if (!isRecord(body)) return "the JSON is not an object";
  if (body.ok !== true) return "the JSON is not a successful wip envelope";
  const data = body.data;
  if (!isRecord(data)) return "data is not an object";
  if (!Array.isArray(data.items)) return "data.items is not an array";
  const board = data.board;
  if (!isRecord(board) || !Array.isArray(board.flows)) return "data.board.flows is not an array";
  const flows: TKanbanFlow[] = [];
  for (const raw of board.flows) {
    if (!isRecord(raw) || typeof raw.name !== "string") continue;
    flows.push({
      name: raw.name,
      source: typeof raw.source === "string" ? raw.source : null,
      phases: stringsOf(raw.phases),
      columns: columnsOf(raw.columns),
    });
  }
  const items: TKanbanItem[] = [];
  for (const raw of data.items) {
    if (!isRecord(raw)) continue;
    if (typeof raw.id !== "string" || typeof raw.flow !== "string") continue;
    if (typeof raw.phase !== "string") continue;
    const signals = isRecord(raw.signals) ? raw.signals : {};
    items.push({
      id: raw.id,
      flow: raw.flow,
      phase: raw.phase,
      attention: signals.attention === true,
    });
  }
  return { items, flows };
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** The project-relative `wip_bin` of `.wip/config.json`, expanded; `wip` from the PATH when there is none. */
async function resolveWip(
  $: EngineInterface,
  root: string,
): Promise<{ bin: string } | { error: string }> {
  const file = `${root.replace(/[\\/]+$/, "")}/.wip/config.json`;
  if (!(await $.fs.exists(file))) return { bin: "wip" };
  let config: unknown;
  try {
    config = JSON.parse(await $.fs.read(file));
  } catch {
    return { error: ".wip/config.json is not valid JSON" };
  }
  if (!isRecord(config)) return { error: ".wip/config.json is not a JSON object" };
  const value = config.wip_bin;
  if (value === undefined || value === null || value === "") return { bin: "wip" };
  if (typeof value !== "string") return { error: "wip_bin in .wip/config.json is not a string" };
  if (value.startsWith("~/")) {
    const home = (await $.env.get("HOME")) ?? (await $.env.get("USERPROFILE"));
    if (home === undefined || home === "") return { error: "wip_bin uses ~ but HOME is not set" };
    return { bin: `${home.replace(/[\\/]+$/, "")}/${value.slice(2)}` };
  }
  if (isAbsolute(value)) return { bin: value };
  const relative = value.startsWith("./") ? value.slice(2) : value;
  return { bin: `${root.replace(/[\\/]+$/, "")}/${relative}` };
}

async function fail($: EngineInterface, reason: string): Promise<void> {
  const error = oneLine(`wip state failed: ${reason}`);
  await update($, snapshot, (current) => ({ ...current, error }));
}

/** One read of `wip state --json`: a valid board replaces the snapshot, a failure keeps the last one. */
async function refresh($: EngineInterface, root: string): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const resolved = await resolveWip($, root);
    if ("error" in resolved) {
      await fail($, resolved.error);
      return;
    }
    let result: { exitCode: number; stdout: string; stderr: string };
    try {
      result = await $.process.run([resolved.bin, "state", "--json"], {
        cwd: root,
        timeoutMs: TIMEOUT_MS,
      });
    } catch (err) {
      await fail($, err instanceof Error ? err.message : String(err));
      return;
    }
    if (result.exitCode !== 0) {
      const why = result.stderr.trim() === "" ? result.stdout : result.stderr;
      await fail($, why.trim() === "" ? `exit ${result.exitCode}` : why);
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(result.stdout);
    } catch {
      await fail($, "wip state --json did not print JSON");
      return;
    }
    const parsed = parseState(body);
    if (typeof parsed === "string") {
      await fail($, parsed);
      return;
    }
    const lastGoodAt = Date.now();
    await update($, snapshot, () => ({ ...parsed, error: null, lastGoodAt }));
  } finally {
    inFlight = false;
  }
}

/** `value` when it is an http(s) URL, or null. */
function httpUrlOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? value : null;
}

/**
 * The URLs of a `wip web status --json` answer: its Local URL, which is present whenever the server runs,
 * and its LAN URL when it has one; null when no server answers or the answer is not one.
 */
function statusUrls(stdout: string): { url: string; lan: string | null } | null {
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(body) || body.ok !== true) return null;
  const data = body.data;
  if (!isRecord(data) || data.state !== "running") return null;
  const url = httpUrlOf(data.url);
  if (url === null) return null;
  return { url, lan: httpUrlOf(data.lan_url) };
}

/**
 * One read of `wip web status --json`: this project's running server replaces the stored URLs with its Local
 * and LAN ones, and any other outcome clears them so the pane falls back to the configured `webUrl`. It never
 * shows an error: the board works without the server.
 */
async function refreshWeb($: EngineInterface, root: string): Promise<void> {
  if (webInFlight) return;
  webInFlight = true;
  try {
    const resolved = await resolveWip($, root);
    if ("error" in resolved) {
      await update($, web, () => ({ url: null, lan: null, at: null }));
      return;
    }
    let urls: { url: string; lan: string | null } | null = null;
    try {
      const result = await $.process.run([resolved.bin, "web", "status", "--json"], {
        cwd: root,
        timeoutMs: TIMEOUT_MS,
      });
      if (result.exitCode === 0) urls = statusUrls(result.stdout);
    } catch {
      urls = null;
    }
    await update($, web, () => ({
      url: urls?.url ?? null,
      lan: urls?.lan ?? null,
      at: Date.now(),
    }));
  } finally {
    webInFlight = false;
  }
}

/** The hidden flows of `root` in a stored value; anything invalid reads as none. */
function hiddenFor(raw: unknown, root: string): string[] {
  if (!isRecord(raw)) return [];
  const list = raw[root];
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((v): v is string => typeof v === "string"))];
}

async function toggle($: EngineInterface, root: string, flow: string): Promise<void> {
  const current = await read($, hiddenFlows);
  const next = current.includes(flow) ? current.filter((f) => f !== flow) : [...current, flow];
  await update($, hiddenFlows, () => next);
  const stored = await $.store.get(HIDDEN_KEY);
  const all = isRecord(stored) ? stored : {};
  await $.store.set(HIDDEN_KEY, { ...all, [root]: next });
}

/**
 * The base the rows link to: the desktop app and the VS Code extension draw a `Link` as plain text unless its
 * URL is `https:` or `http://localhost`, so there they take the server's Local URL and the LAN one only when it
 * has none. Every other surface (the terminal) takes the LAN URL first, then the Local one. With no live
 * server, the configured `webUrl`.
 */
function webBase(live: TKanbanWeb, surface: string, fallback: string): string {
  const preferred =
    surface === "desktop" || surface === "vscode" ? (live.url ?? live.lan) : (live.lan ?? live.url);
  return preferred ?? fallback;
}

/** The item's link into `wip web`, or null when the base URL is not an http(s) URL. */
function itemHref(base: string, flow: string, id: string): string | null {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  url.searchParams.set("item", `${flow}/${id}`);
  return url.toString();
}

function truncate(label: string, width: number): string {
  if (label.length <= width) return label;
  if (width <= 1) return "…";
  return `${label.slice(0, width - 1)}…`;
}

/** The pane's drawing width: a non-positive or non-finite `bodyColumns` falls back to `PANE_COLUMNS`. */
function bodyWidth(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : PANE_COLUMNS;
}

/** The flow's own tone at full opacity: `column.color` is the CSS `rgba()` the web paints the stage with. */
function flowTone(column: TKanbanColumn): string | null {
  const match = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/.exec(
    column.color,
  );
  const [, r, g, b] = match ?? [];
  if (r === undefined || g === undefined || b === undefined) return null;
  return `rgb(${r}, ${g}, ${b})`;
}

interface IRow {
  label: string;
  offset: number;
  color: string | null;
  background: string | null;
  attention: boolean;
}

/**
 * `<id> <phase>`, placed by the phase's ordinal; an attention row paints the stage's solid colour as its
 * background, every other row paints the flow's tone at full opacity.
 */
function rowOf(
  item: TKanbanItem,
  flow: TKanbanFlow | null,
  width: number,
  scheme: "dark" | "light",
): IRow {
  const phases = flow?.phases ?? [];
  const index = phases.indexOf(item.phase);
  const known = flow !== null && index >= 0;
  const ratio = !known || phases.length <= 1 ? 0 : index / (phases.length - 1);
  const label = truncate(`${known ? "" : "! "}${item.id} ${item.phase}`, width);
  const offset = Math.round(ratio * Math.max(0, width - label.length));
  const column = known ? flow?.columns.find((c) => c.phases.includes(item.phase)) : undefined;
  const solid = column !== undefined && column.alpha !== null;
  const tone = column === undefined ? null : flowTone(column);
  const color = solid ? (scheme === "light" ? column.color_light : column.color_dark) : null;
  const onColor = solid ? (scheme === "light" ? column.text : column.text_dark) : null;
  if (item.attention) {
    if (solid && color !== null && onColor !== null) {
      return { label, offset, color: onColor, background: color, attention: true };
    }
    const fallback = scheme === "light" ? ATTENTION_LIGHT : ATTENTION_DARK;
    return {
      label,
      offset,
      color: fallback.text,
      background: fallback.background,
      attention: true,
    };
  }
  return { label, offset, color: tone, background: null, attention: false };
}

export const register: Register = (on, options) => {
  const scheme = options.colorScheme === "light" ? "light" : "dark";
  const configuredWebUrl = typeof options.webUrl === "string" ? options.webUrl : DEFAULT_WEB_URL;

  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "wip-kanban",
      description: "Show a read-only board of the project's open wip items",
      argumentHint: "on|off",
    });
    const root = await $.session.root();
    sessionRoot = root;
    const stored = await $.store.get(HIDDEN_KEY);
    await update($, hiddenFlows, () => hiddenFor(stored, root));
    let problem: string | null = null;
    try {
      const opened = await $.ui.open({
        id: PANE_ID,
        title: PANE_TITLE,
        columns: PANE_COLUMNS,
        rows: PANE_ROWS,
      });
      if (opened?.isPlaced === false) problem = `is waiting: ${unplacedReason(opened)}`;
    } catch (err) {
      problem = `did not open: ${err instanceof Error ? err.message : String(err)}`;
    }
    paneUnplaced = problem !== null;
    if (problem !== null) {
      try {
        $.ui.toast(`wip Kanban ${problem}. Run /wip-kanban on.`);
      } catch {
        // A toast is a convenience: a surface that rejects it must not fail the session's start.
      }
    }
    await refresh($, root);
    await refreshWeb($, root);
    let ticks = 0;
    $.clock.every(TICK_MS, () => {
      void refresh($, root);
      if (ticks++ % WEB_REFRESH_TICKS === 0) void refreshWeb($, root);
    });
    return next(e);
  });

  // A prompt sent by the person is an asked action for the engine: reopening there places the pane that
  // `session.start` left unplaced (from 110 columns instead of 144) and the engine remembers the id.
  on("prompt.submit", async ($, e, next) => {
    if (paneUnplaced) {
      try {
        const opened = await $.ui.open({
          id: PANE_ID,
          title: PANE_TITLE,
          columns: PANE_COLUMNS,
          rows: PANE_ROWS,
        });
        paneUnplaced = opened?.isPlaced === false;
      } catch {
        paneUnplaced = true;
      }
    }
    return next(e);
  });

  on("command.run", { command: "wip-kanban" }, async ($, e) => {
    const arg = e.args.trim();
    if (arg === "on") {
      const root = sessionRoot ?? (await $.session.root());
      sessionRoot = root;
      let opened: UiOpenResult | undefined;
      try {
        opened = await $.ui.open({
          id: PANE_ID,
          title: PANE_TITLE,
          columns: PANE_COLUMNS,
          rows: PANE_ROWS,
          focus: true,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        try {
          $.ui.toast(`wip Kanban could not open: ${reason}`);
        } catch {
          // The reply is the durable contract; the toast only repeats it.
        }
        paneUnplaced = true;
        const base = webBase(await read($, web), "terminal", configuredWebUrl);
        return { text: `wip Kanban could not open: ${reason}. The board is at ${base}` };
      }
      const placed = opened?.isPlaced !== false;
      paneUnplaced = !placed;
      if (!inFlight) void refresh($, root);
      if (!webInFlight) void refreshWeb($, root);
      if (!placed) {
        const message = `wip Kanban is waiting: ${unplacedReason(opened)}`;
        try {
          $.ui.toast(message);
        } catch {
          // The reply is the durable contract; the toast only repeats it.
        }
        const base = webBase(await read($, web), "terminal", configuredWebUrl);
        return { text: `${message}. The board is at ${base}` };
      }
      let shown = true;
      try {
        shown = (await $.ui.panes()).find((p) => p.id === PANE_ID)?.isShown !== false;
      } catch {
        // Without the list, the open's placed answer stays the answer.
      }
      return {
        text: shown ? "wip Kanban opened." : "wip Kanban opened behind another pane; pick its tab.",
      };
    }
    if (arg === "off") {
      await $.ui.close({ id: PANE_ID });
      return { text: "wip Kanban closed." };
    }
    return { text: "Usage: /wip-kanban on|off" };
  });

  on("ui.render", { component: "Pane", requestId: PANE_ID }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e);
    const state = await read($, snapshot);
    const live = await read($, web);
    const hidden = await read($, hiddenFlows);
    const width = bodyWidth(e.props.bodyColumns);
    const base = webBase(live, e.surface, configuredWebUrl);
    const linkable = itemHref(base, "x", "y") !== null;
    const visible = state.flows.filter((f) => !hidden.includes(f.name));
    const rows = visible.map((flow) => ({
      flow,
      items: state.items.filter((i) => i.flow === flow.name),
    }));
    const allHidden = state.flows.length > 0 && visible.length === 0;
    const anyItems = rows.some((r) => r.items.length > 0);
    const noReadYet = state.error !== null && state.lastGoodAt === null;

    return (
      <Box flexDirection="column">
        {state.error !== null && <Text color="yellow">{state.error}</Text>}
        {rows.map(({ flow, items }) => (
          <Box key={`flow:${flow.name}`} flexDirection="column">
            {items.map((item) => {
              const href = itemHref(base, item.flow, item.id);
              const row = rowOf(item, flow, width, scheme);
              const indent = " ".repeat(row.offset);
              if (href === null) {
                return (
                  <Text
                    color={row.color ?? undefined}
                    backgroundColor={row.background ?? undefined}
                  >
                    {`${indent}${row.label}`}
                  </Text>
                );
              }
              return (
                <Link href={href}>
                  <Text
                    color={row.color ?? undefined}
                    backgroundColor={row.background ?? undefined}
                  >
                    {`${indent}${row.label}`}
                  </Text>
                </Link>
              );
            })}
          </Box>
        ))}
        {allHidden && <Text dimColor>All flows are hidden; press one below to show it.</Text>}
        {!allHidden && !anyItems && !noReadYet && <Text dimColor>No open items.</Text>}
        {!linkable && (
          <Text color="yellow">webUrl is not a valid http(s) URL; items are not links.</Text>
        )}
        {state.flows.length > 0 && (
          <Box
            key="filters"
            flexDirection="row"
            justifyContent="flex-end"
            flexWrap="wrap"
            columnGap={1}
            width={width}
          >
            {state.flows.map((f) => {
              const isHidden = hidden.includes(f.name);
              return (
                <Button
                  key={`filter:${f.name}`}
                  plain
                  label={isHidden ? `Show ${f.name}` : `Hide ${f.name}`}
                  onPress={() => {
                    const root = sessionRoot;
                    if (root !== null) void toggle($, root, f.name);
                  }}
                >
                  <Text color={isHidden ? "red" : "green"}>
                    {isHidden ? HIDDEN_MARK : SHOWN_MARK}
                  </Text>
                  <Text dimColor>{` ${f.name}`}</Text>
                </Button>
              );
            })}
          </Box>
        )}
      </Box>
    );
  });
};
