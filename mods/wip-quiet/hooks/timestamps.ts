// biome-ignore lint/suspicious/noTsIgnore: the engine module exists only inside Claude Code; the mod's own tsconfig types it.
// @ts-ignore
import type { EngineInterface } from "claude-code";

// Every message row of the transcript file stores `"uuid":"…","timestamp":"…"` side by side; an
// assistant row names its API message id (`"id":"msg_…"`) earlier on the same line. grep reads only
// those, so a transcript of any size answers in one small output (no 4 MiB file read).
export const GREP_PATTERN = '"id":"msg_[A-Za-z0-9]+"|"uuid":"[0-9a-f-]{36}","timestamp":"[^"]+"';
const MATCH_LINE =
  /^(\d+):(?:"id":"(msg_[A-Za-z0-9]+)"|"uuid":"([0-9a-f-]{36})","timestamp":"([^"]+)")$/;

// A miss re-reads the file at most this often; the rows drawn meanwhile use the fallback.
const RELOAD_MS = 2000;
const GREP_TIMEOUT_MS = 10_000;

const pad = (n: number) => String(n).padStart(2, "0");

const lastSundayUtc = (year: number, month: number) => {
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  return Date.UTC(year, month, lastDay.getUTCDate() - lastDay.getUTCDay(), 1);
};

// Europe/Madrid by the EU rule: CEST (+2) from the last Sunday of March to the last Sunday of
// October, both at 01:00 UTC; CET (+1) otherwise. No Intl: the module's runtime may lack tz data.
export const madridOffsetMs = (ms: number) => {
  const year = new Date(ms).getUTCFullYear();
  const isSummer = ms >= lastSundayUtc(year, 2) && ms < lastSundayUtc(year, 9);
  return (isSummer ? 2 : 1) * 3_600_000;
};

/** `HH:MM YYYY-MM-DD` in Europe/Madrid. */
export const formatStamp = (ms: number) => {
  const local = new Date(ms + madridOffsetMs(ms));
  const time = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
  const date = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
  return `${time} ${date}`;
};

/** Row uuid → time, and API message id → time of its first row (a reply's first block). */
export const parseIndex = (grepOutput: string) => {
  const byId = new Map<string, number>();
  let pendingLine = "";
  let pendingMessageId: string | undefined;
  for (const line of grepOutput.split("\n")) {
    const match = MATCH_LINE.exec(line);
    if (match === null) continue;
    const [, lineNo = "", messageId, uuid, iso] = match;
    if (messageId !== undefined) {
      pendingLine = lineNo;
      pendingMessageId = messageId;
      continue;
    }
    const ms = Date.parse(iso ?? "");
    if (uuid === undefined || Number.isNaN(ms)) continue;
    byId.set(uuid, ms);
    if (pendingMessageId !== undefined && pendingLine === lineNo && !byId.has(pendingMessageId)) {
      byId.set(pendingMessageId, ms);
    }
    pendingMessageId = undefined;
  }
  return byId;
};

export const projectSlug = (dir: string) => dir.replace(/[^a-zA-Z0-9]/g, "-");

type TIndex = { sessionId: string; path: string | null; size: number; byId: Map<string, number> };

// Module state: a reload starts it over, and the transcript is grepped again once.
let index: TIndex | undefined;
let loading: Promise<TIndex> | undefined;
let lastLoadAt = 0;
const firstSeen = new Map<string, number>();
const missLogged = new Set<string>();

// Every function handed `$` is a declaration: the engine follows `$` past an import only into those.
async function findTranscript($: EngineInterface, sessionId: string) {
  const configDir =
    (await $.env.get("CLAUDE_CONFIG_DIR")) ?? `${(await $.env.get("HOME")) ?? ""}/.claude`;
  const projects = `${configDir}/projects`;
  const file = `${sessionId}.jsonl`;
  for (const dir of [await $.session.root(), await $.session.cwd()]) {
    const path = `${projects}/${projectSlug(dir)}/${file}`;
    if (await $.fs.exists(path)) return path;
  }
  // Long paths get a hashed slug: look for the file in every project folder.
  for (const entry of await $.fs.list(projects)) {
    if (entry.kind !== "dir") continue;
    const path = `${projects}/${entry.name}/${file}`;
    if (await $.fs.exists(path)) return path;
  }
  return null;
}

async function loadIndex($: EngineInterface, sessionId: string, now: number): Promise<TIndex> {
  lastLoadAt = now;
  const known = index?.sessionId === sessionId ? index : undefined;
  const path = known?.path ?? (await findTranscript($, sessionId));
  if (path === null) return { sessionId, path, size: 0, byId: new Map() };
  const { size } = await $.fs.stat(path);
  if (known !== undefined && known.path === path && known.size === size) return known;
  const { stdout } = await $.process.run(["grep", "-noE", GREP_PATTERN, path], {
    timeoutMs: GREP_TIMEOUT_MS,
  });
  return { sessionId, path, size, byId: parseIndex(stdout) };
}

// One load at a time: rows drawn together share it.
function refreshIndex($: EngineInterface, sessionId: string, now: number) {
  loading ??= loadIndex($, sessionId, now)
    .then((next) => (index = next))
    .finally(() => (loading = undefined));
  return loading as Promise<TIndex>;
}

function firstDrawTime($: EngineInterface, requestId: string, now: number, reason: string) {
  if (!missLogged.has(requestId)) {
    missLogged.add(requestId);
    $.ui.log(`wip-quiet: timestamp of ${requestId} from its first draw (${reason})`, {
      to: "debug",
    });
  }
  const seen = firstSeen.get(requestId);
  if (seen !== undefined) return seen;
  firstSeen.set(requestId, now);
  return now;
}

/**
 * The time a drawn message was sent, in ms: the saved transcript's, matched by the row's
 * `requestId` (row uuid, or API message id). The file is grepped once per session and again only
 * when a row is missing, the file grew and `RELOAD_MS` passed. A row it cannot match keeps the
 * time it was first drawn (fallback).
 */
export async function stampOf($: EngineInterface, requestId: string): Promise<number> {
  const now = await $.clock.now().catch(() => Date.now());
  try {
    const sessionId = await $.session.id();
    let current: TIndex =
      index !== undefined && index.sessionId === sessionId
        ? index
        : await refreshIndex($, sessionId, now);
    let found = current.byId.get(requestId);
    if (found === undefined && now - lastLoadAt >= RELOAD_MS) {
      current = await refreshIndex($, sessionId, now);
      found = current.byId.get(requestId);
    }
    if (found !== undefined) return found;
    return firstDrawTime(
      $,
      requestId,
      now,
      current.path === null ? "no transcript file" : "not in transcript",
    );
  } catch (error) {
    return firstDrawTime($, requestId, now, String(error));
  }
}
