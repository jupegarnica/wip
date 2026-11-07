import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  type Stats,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";

// Pruning of an archived item's folder: what goes (D1-D7), what tmp/ keeps (R1-R2) and what is never touched.
// Pure helpers over the filesystem: no database here and nothing is ever deleted, only renamed into a staging folder.

export type TRuleId = "D1" | "D2" | "D3" | "D4" | "D5" | "D6" | "D7";
export const RULE_IDS: readonly TRuleId[] = ["D1", "D2", "D3", "D4", "D5", "D6", "D7"];

export const RULES: readonly { id: TRuleId; scope: string; test: string }[] = [
  { id: "D1", scope: "any level (not in _backup/)", test: "directory storybook-static" },
  { id: "D2", scope: "tmp/", test: "regular file of 1 MB or more with a Mach-O or ELF header" },
  { id: "D3", scope: "any level below the root", test: "directory node_modules" },
  {
    id: "D4",
    scope: "any level below the root",
    test: "browser profile: directory chrome-prof* or with Default/Login Data or Local State",
  },
  {
    id: "D5",
    scope: "any level below the root",
    test: "directory __pycache__, files *.pyc and .DS_Store",
  },
  { id: "D6", scope: "tmp/", test: "files *.sqlite, *.sqlite-wal, *.sqlite-shm, *.db" },
  { id: "D7", scope: "tmp/", test: "everything else in tmp/ except R1, R2 and --keep" },
];

export interface IEntry {
  rule: TRuleId;
  /** Relative to the item folder, "/" separated. */
  path: string;
  dir: boolean;
  bytes: number;
  files: number;
  sha256?: string;
}

export interface IRescue {
  rule: "R1" | "R2";
  path: string;
  bytes: number;
  cited_in: string;
}

export interface IPlan {
  dir: string;
  entries: IEntry[];
  rescued: IRescue[];
  kept: string[];
  /** Browser profiles at the item root: protected like every root entry, reported so the user can decide. */
  rootKept: string[];
}

export interface IPruneError {
  path: string;
  code: string;
}

const MB = 1024 * 1024;
const EXEC_MAGIC = new Set([
  "feedfacf",
  "cffaedfe",
  "feedface",
  "cefaedfe",
  "cafebabe",
  "7f454c46",
]);
const MEDIA_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "mp4",
  "webm",
  "mov",
  "pdf",
  "svg",
]);
const TEXT_EXT = new Set([
  "md",
  "txt",
  "json",
  "tsv",
  "csv",
  "diff",
  "patch",
  "sh",
  "ts",
  "py",
  "yml",
]);
const DB_RE = /\.(sqlite|sqlite-wal|sqlite-shm|db)$/;
const PROTECTED_ROOT_DIRS = new Set(["gifs", "evidence", "design"]);

const ext = (name: string): string => extname(name).slice(1).toLowerCase();

/** First 4 bytes are a Mach-O or ELF header (only these bytes are read). */
export function isExecutable(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(4);
    if (readSync(fd, buf, 0, 4, 0) < 4) return false;
    return EXEC_MAGIC.has(buf.toString("hex"));
  } finally {
    closeSync(fd);
  }
}

/** Chromium profile, by name and existence only: nothing inside is opened. */
export function isBrowserProfile(dir: string): boolean {
  return (
    basename(dir).startsWith("chrome-prof") ||
    existsSync(join(dir, "Default", "Login Data")) ||
    existsSync(join(dir, "Local State"))
  );
}

/** Bytes and regular files under `path`, never following links. */
export function measure(path: string): { bytes: number; files: number } {
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch {
    return { bytes: 0, files: 0 };
  }
  if (st.isSymbolicLink()) return { bytes: 0, files: 0 };
  if (st.isFile()) return { bytes: st.size, files: 1 };
  if (!st.isDirectory()) return { bytes: 0, files: 0 };
  let bytes = 0;
  let files = 0;
  for (const name of readdirSync(path)) {
    const m = measure(join(path, name));
    bytes += m.bytes;
    files += m.files;
  }
  return { bytes, files };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Text of every .md of the item outside tmp/ (2 MB each at most), read once: the citation index of R1/R2. */
function citationIndex(root: string): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs).sort()) {
      if (rel === "" && (name === "tmp" || name === "prune.md")) continue;
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const st = lstatOrNull(childAbs);
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(childAbs, childRel);
      else if (st.isFile() && ext(name) === "md" && st.size <= 2 * MB) {
        try {
          out.push({ name: childRel, text: readFileSync(childAbs, "utf8") });
        } catch {
          // Unreadable: it simply cites nothing.
        }
      }
    }
  };
  walk(root, "");
  return out;
}

interface IWalk {
  keep: Set<string>;
  index: { name: string; text: string }[];
  entries: IEntry[];
  rescued: IRescue[];
  kept: string[];
  rootKept: string[];
}

const isKept = (w: IWalk, rel: string): boolean => w.keep.has(rel);

function keepsInside(w: IWalk, rel: string): boolean {
  for (const k of w.keep) if (k.startsWith(`${rel}/`)) return true;
  return false;
}

function citedBy(w: IWalk, token: string): string | null {
  for (const md of w.index) if (md.text.includes(token)) return md.name;
  return null;
}

type TMode = "tmp" | "free" | "backup" | "protected";

/** D1/D3/D4/D5 for a directory, given where it is. D4 holds everywhere. */
function dirRule(abs: string, name: string, mode: TMode): TRuleId | null {
  if (isBrowserProfile(abs)) return "D4";
  if (mode === "protected") return null;
  if (name === "storybook-static" && mode !== "backup") return "D1";
  if (name === "node_modules") return "D3";
  if (name === "__pycache__") return "D5";
  return null;
}

const isD5File = (name: string): boolean => name === ".DS_Store" || ext(name) === "pyc";

interface ITmpWalk {
  d7: IEntry[];
  protectedHere: boolean;
  restBytes: number;
  restFiles: number;
}

/** tmp/ subtree: D1-D6 entries go straight to w.entries; D7 is collapsed to the largest folders with nothing kept. */
function walkTmp(w: IWalk, abs: string, rel: string): ITmpWalk {
  const res: ITmpWalk = { d7: [], protectedHere: false, restBytes: 0, restFiles: 0 };
  for (const name of readdirSync(abs).sort()) {
    const childAbs = join(abs, name);
    const childRel = `${rel}/${name}`;
    const st = lstatOrNull(childAbs);
    if (!st) continue;
    if (st.isSymbolicLink()) {
      res.protectedHere = true;
      continue;
    }
    if (st.isDirectory()) {
      const rule = dirRule(childAbs, name, "tmp");
      if (rule !== "D4" && isKept(w, childRel)) {
        res.protectedHere = true;
        w.kept.push(childRel);
        continue;
      }
      if (rule) {
        w.entries.push({ rule, path: childRel, dir: true, ...measure(childAbs) });
        continue;
      }
      const sub = walkTmp(w, childAbs, childRel);
      if (sub.protectedHere || keepsInside(w, childRel)) {
        res.protectedHere = true;
        res.d7.push(...sub.d7);
      } else {
        res.d7.push({
          rule: "D7",
          path: childRel,
          dir: true,
          bytes: sub.restBytes,
          files: sub.restFiles,
        });
        res.restBytes += sub.restBytes;
        res.restFiles += sub.restFiles;
      }
      continue;
    }
    if (!st.isFile()) {
      res.protectedHere = true;
      continue;
    }
    let rule: TRuleId | null = null;
    if (isD5File(name)) rule = "D5";
    else if (DB_RE.test(name)) rule = "D6";
    else if (st.size >= MB && isExecutable(childAbs)) rule = "D2";
    if (isKept(w, childRel)) {
      res.protectedHere = true;
      w.kept.push(childRel);
      continue;
    }
    if (rule) {
      w.entries.push({
        rule,
        path: childRel,
        dir: false,
        bytes: st.size,
        files: 1,
        ...(rule === "D2" ? { sha256: sha256(childAbs) } : {}),
      });
      continue;
    }
    const e = ext(name);
    if (MEDIA_EXT.has(e)) {
      const by = (name.length >= 6 ? citedBy(w, name) : null) ?? citedBy(w, childRel);
      if (by) {
        w.rescued.push({ rule: "R1", path: childRel, bytes: st.size, cited_in: by });
        res.protectedHere = true;
        continue;
      }
    } else if (TEXT_EXT.has(e) && st.size <= MB) {
      const by = citedBy(w, childRel);
      if (by) {
        w.rescued.push({ rule: "R2", path: childRel, bytes: st.size, cited_in: by });
        res.protectedHere = true;
        continue;
      }
    }
    res.d7.push({ rule: "D7", path: childRel, dir: false, bytes: st.size, files: 1 });
    res.restBytes += st.size;
    res.restFiles += 1;
  }
  return res;
}

/**
 * Everything outside tmp/. Every entry at the root of the item folder stays: the root files untouched, each root
 * directory only walked (`_backup/` D3-D5; `gifs/`, `evidence/`, `design/`, `qa-*` only D4; the others D1, D3-D5).
 */
function walkOther(w: IWalk, abs: string, rel: string, mode: TMode | "root"): void {
  for (const name of readdirSync(abs).sort()) {
    if (rel === "" && name === "tmp") continue;
    const childAbs = join(abs, name);
    const childRel = rel ? `${rel}/${name}` : name;
    const st = lstatOrNull(childAbs);
    if (!st || st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      if (mode === "root") {
        if (isBrowserProfile(childAbs)) w.rootKept.push(`${childRel}/`);
        let childMode: TMode = "free";
        if (name === "_backup") childMode = "backup";
        else if (PROTECTED_ROOT_DIRS.has(name) || name.startsWith("qa-")) childMode = "protected";
        walkOther(w, childAbs, childRel, childMode);
        continue;
      }
      const rule = dirRule(childAbs, name, mode);
      if (rule && rule !== "D4" && isKept(w, childRel)) {
        w.kept.push(childRel);
        continue;
      }
      if (rule) w.entries.push({ rule, path: childRel, dir: true, ...measure(childAbs) });
      else walkOther(w, childAbs, childRel, mode);
      continue;
    }
    if (st.isFile() && mode !== "root" && mode !== "protected" && isD5File(name)) {
      if (isKept(w, childRel)) {
        w.kept.push(childRel);
        continue;
      }
      w.entries.push({ rule: "D5", path: childRel, dir: false, bytes: st.size, files: 1 });
    }
  }
}

/** What a prune of `dir` (the real path of an item folder) would move. Reads only .md outside tmp/ and 4-byte headers. */
export function planPrune(dir: string, opts: { keep?: readonly string[] } = {}): IPlan {
  const w: IWalk = {
    keep: new Set(opts.keep ?? []),
    index: citationIndex(dir),
    entries: [],
    rescued: [],
    kept: [],
    rootKept: [],
  };
  walkOther(w, dir, "", "root");
  const tmpAbs = join(dir, "tmp");
  const tmpSt = lstatOrNull(tmpAbs);
  if (tmpSt?.isDirectory() && !tmpSt.isSymbolicLink()) {
    if (isKept(w, "tmp")) w.kept.push("tmp");
    else {
      const res = walkTmp(w, tmpAbs, "tmp");
      if (res.protectedHere || keepsInside(w, "tmp")) w.entries.push(...res.d7);
      else
        w.entries.push({
          rule: "D7",
          path: "tmp",
          dir: true,
          bytes: res.restBytes,
          files: res.restFiles,
        });
    }
  }
  return { dir, entries: w.entries, rescued: w.rescued, kept: w.kept, rootKept: w.rootKept };
}

/** Move `src` to `dst`, merging into a folder already there (created as the parent of an entry moved before). */
function moveInto(src: string, dst: string): void {
  if (!existsSync(dst)) {
    mkdirSync(dirname(dst), { recursive: true });
    renameSync(src, dst);
    return;
  }
  const s = lstatSync(src);
  const d = lstatSync(dst);
  if (!s.isDirectory() || !d.isDirectory()) {
    throw Object.assign(new Error(`already exists: ${dst}`), { code: "EEXIST" });
  }
  for (const name of readdirSync(src)) moveInto(join(src, name), join(dst, name));
  rmdirSync(src);
}

export interface IApplied {
  moved: IEntry[];
  errors: IPruneError[];
}

/**
 * Stage a plan: D1-D6 first, then D7 (a D7 folder may hold a D1-D6 entry already moved). Each entry is renamed to
 * `<staging>/<rel>` (same volume). Errors are collected and the rest goes on. Nothing is removed.
 */
export function stagePrune(plan: IPlan, staging: string): IApplied {
  const ordered = [
    ...plan.entries.filter((e) => e.rule !== "D7"),
    ...plan.entries.filter((e) => e.rule === "D7"),
  ];
  const moved: IEntry[] = [];
  const errors: IPruneError[] = [];
  for (const e of ordered) {
    try {
      moveInto(join(plan.dir, e.path), join(staging, e.path));
      moved.push(e);
    } catch (err) {
      errors.push({
        path: e.path,
        code: (err as NodeJS.ErrnoException).code ?? (err as Error).message,
      });
    }
  }
  return { moved, errors };
}

// ---- rendering ----

export function fmtMb(bytes: number): string {
  return (bytes / MB).toFixed(1);
}

export function ruleTotals(entries: readonly IEntry[]): Partial<Record<TRuleId, number>> {
  const out: Partial<Record<TRuleId, number>> = {};
  for (const e of entries) out[e.rule] = (out[e.rule] ?? 0) + e.bytes;
  return out;
}

const shown = (e: IEntry): string => (e.dir ? `${e.path}/` : e.path);

/** One line per rule: MB, files and up to 4 paths. */
export function ruleLines(entries: readonly IEntry[], rescued: readonly IRescue[]): string[] {
  const lines: string[] = [];
  for (const id of RULE_IDS) {
    const list = entries.filter((e) => e.rule === id);
    if (!list.length) continue;
    const bytes = list.reduce((s, e) => s + e.bytes, 0);
    const files = list.reduce((s, e) => s + e.files, 0);
    let paths = list.slice(0, 4).map(shown).join(", ");
    if (list.length > 4) paths += `, ... (${list.length} entries)`;
    if (id === "D2")
      paths += ` (${list.map((e) => `sha256 ${(e.sha256 ?? "").slice(0, 8)}...`).join(", ")})`;
    lines.push(`  ${id} ${fmtMb(bytes).padStart(8)} MB ${String(files).padStart(7)} f  ${paths}`);
  }
  for (const id of ["R1", "R2"] as const) {
    const list = rescued.filter((r) => r.rule === id);
    if (!list.length) continue;
    const bytes = list.reduce((s, r) => s + r.bytes, 0);
    let paths = list
      .slice(0, 4)
      .map((r) => `${r.path} (${r.cited_in})`)
      .join(", ");
    if (list.length > 4) paths += `, ... (${list.length} rescues)`;
    lines.push(
      `  ${id} ${fmtMb(bytes).padStart(8)} MB ${String(list.length).padStart(7)} f  ${paths}`,
    );
  }
  return lines;
}

/** Full detail of one item, one line per entry (prune.md and --report). */
export function entryLines(
  entries: readonly IEntry[],
  rescued: readonly IRescue[],
  kept: readonly string[],
  errors: readonly IPruneError[],
  rootKept: readonly string[] = [],
): string[] {
  const lines: string[] = [];
  if (entries.length) {
    lines.push("", "### Entries", "");
    for (const e of entries) {
      lines.push(
        `- ${e.rule} · ${shown(e)} · ${fmtMb(e.bytes)} MB · ${e.files} f${e.sha256 ? ` · sha256 ${e.sha256}` : ""}`,
      );
    }
  }
  if (rescued.length) {
    lines.push("", "### Rescues (kept)", "");
    for (const r of rescued) {
      lines.push(`- ${r.rule} · ${r.path} · ${fmtMb(r.bytes)} MB · cited in ${r.cited_in}`);
    }
  }
  if (kept.length) {
    lines.push("", "### --keep (kept)", "");
    for (const k of kept) lines.push(`- ${k}`);
  }
  if (rootKept.length) {
    lines.push("", "### Kept at the root (browser profile)", "");
    for (const k of rootKept) lines.push(`- ${k}`);
  }
  if (errors.length) {
    lines.push("", "### Errors", "");
    for (const e of errors) lines.push(`- ${e.path} · ${e.code}`);
  }
  return lines;
}
