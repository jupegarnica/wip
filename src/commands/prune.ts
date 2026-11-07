import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { type IArgs, need } from "../args.ts";
import { compact, iso } from "../clock.ts";
import type { ICtx, IHandler } from "../context.ts";
import type { TDatabase } from "../db.ts";
import { artifactDir, type IRoot } from "../env.ts";
import { EXIT, rejected, usage } from "../errors.ts";
import { addEvent, getItem, type IItemRow } from "../items.ts";
import {
  entryLines,
  fmtMb,
  type IEntry,
  type IPlan,
  type IPruneError,
  type IRescue,
  measure,
  planPrune,
  RULE_IDS,
  ruleLines,
  ruleTotals,
  stagePrune,
} from "../prune.ts";
import { type ITrashCmd, TRASH_HINT, trash, trashCommand } from "../trash.ts";
import { noExtra } from "./phase.ts";

export interface IItemPrune {
  id: string;
  flow: string;
  artifact_dir: string | null;
  archived_at: string | null;
  bytes: number;
  files: number;
  entries: IEntry[];
  rescued: IRescue[];
  kept: string[];
  root_kept: string[];
  skipped?: string;
  /** The skip reason refuses a single-item prune (exit 3) instead of only skipping it. */
  refuse?: boolean;
  errors: IPruneError[];
}

export interface IPruneRun {
  dry_run: boolean;
  items: IItemPrune[];
  totals: Partial<Record<string, number>>;
  trash: string | null;
  /** Staging folders in .wip/tmp that the trash did not take (this run's, or a leftover that failed again). */
  staged: string[];
  /** Leftover staging folders of an earlier run that this run sent to the trash. */
  retried: string[];
  warnings: string[];
  events: Record<string, unknown>[];
}

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const contains = (outer: string, inner: string): boolean =>
  outer === inner || inner.startsWith(outer + sep);

/** Where the item folder is, or why it is not pruned. */
function folderOf(
  root: IRoot,
  db: TDatabase | null,
  item: IItemRow,
): { dir: string } | { skip: string; refuse: boolean } {
  if (!item.artifact_dir) return { skip: "no folder", refuse: false };
  if (!existsSync(item.artifact_dir)) return { skip: "folder does not exist", refuse: false };
  if (lstatSync(item.artifact_dir).isSymbolicLink()) {
    return { skip: "the folder is a symbolic link", refuse: true };
  }
  const dir = realpathSync(item.artifact_dir);
  const expected = real(artifactDir(root, item.flow, item.id));
  if (dir !== expected) {
    return { skip: `folder is not .wip/items/${item.flow}/${item.id}: ${dir}`, refuse: true };
  }
  const open = db
    ? (db
        .query(
          "SELECT id, artifact_dir FROM items WHERE status = 'open' AND artifact_dir IS NOT NULL AND id <> ?",
        )
        .all(item.id) as { id: string; artifact_dir: string }[])
    : [];
  for (const o of open) {
    if (!existsSync(o.artifact_dir)) continue;
    const other = real(o.artifact_dir);
    if (contains(other, dir) || contains(dir, other)) {
      return { skip: `folder shared with the open item ${o.id}`, refuse: true };
    }
  }
  return { dir };
}

/** --keep paths relative to the item folder: relative ones as given, absolute ones only when inside it. */
function keepFor(keep: readonly string[], dir: string): string[] {
  const out: string[] = [];
  for (const raw of keep) {
    let k = raw.replace(/\/+$/, "");
    if (isAbsolute(k)) {
      k = relative(dir, real(k));
      if (!k || k.startsWith("..") || isAbsolute(k)) continue;
    }
    out.push(k.replace(/^\.\//, "").split(sep).join("/"));
  }
  return out;
}

function stagingDir(root: IRoot, ts: string): string {
  const base = join(root.tmp, `wip-prune-${ts.replace(/[TZ]/g, "")}`);
  let dir = base;
  for (let n = 2; existsSync(dir); n++) dir = `${base}-${n}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

function pruneMd(r: IItemPrune, moved: readonly IEntry[], dest: string): string {
  const bytes = moved.reduce((s, e) => s + e.bytes, 0);
  const files = moved.reduce((s, e) => s + e.files, 0);
  const totals = ruleTotals(moved);
  const rules = RULE_IDS.filter((id) => totals[id] !== undefined)
    .map((id) => `${id} ${fmtMb(totals[id] ?? 0)} MB`)
    .join(" · ");
  const lines = [
    `# Prune of ${r.id}`,
    "",
    `- Date: ${iso()}`,
    `- Destination: ${dest}`,
    `- Total: ${fmtMb(bytes)} MB in ${files} files`,
    `- Rules: ${rules || "none"}`,
    "- The rules are in the README of wip, section `wip prune`.",
  ];
  if (moved.some((e) => e.rule === "D4")) {
    lines.push("- It held browser profiles (D4): empty that folder of the trash when you like.");
  }
  lines.push(...entryLines(moved, r.rescued, r.kept, r.errors, r.root_kept), "");
  return lines.join("\n");
}

interface IRunOptions {
  dryRun: boolean;
  keep: readonly string[];
  cmd: ITrashCmd | null;
}

/**
 * Plan and (unless dry-run) apply the prune of `items`: one staging folder and one call to the trash command for all
 * of them. Writes prune.md and one `pruned` milestone per item that lost something. Never throws for a single item.
 */
export function runPrune(
  ctx: ICtx,
  db: TDatabase | null,
  items: readonly IItemRow[],
  opts: IRunOptions,
): IPruneRun {
  const root = ctx.root;
  const run: IPruneRun = {
    dry_run: opts.dryRun,
    items: [],
    totals: {},
    trash: null,
    staged: [],
    retried: [],
    warnings: [],
    events: [],
  };
  const plans = new Map<string, IPlan>();
  for (const item of items) {
    const r: IItemPrune = {
      id: item.id,
      flow: item.flow,
      artifact_dir: item.artifact_dir,
      archived_at: item.archived_at,
      bytes: 0,
      files: 0,
      entries: [],
      rescued: [],
      kept: [],
      root_kept: [],
      errors: [],
    };
    run.items.push(r);
    const f = folderOf(root, db, item);
    if ("skip" in f) {
      r.skipped = f.skip;
      r.refuse = f.refuse;
      continue;
    }
    const plan = planPrune(f.dir, { keep: keepFor(opts.keep, f.dir) });
    plans.set(item.id, plan);
    r.entries = plan.entries;
    r.rescued = plan.rescued;
    r.kept = plan.kept;
    r.root_kept = plan.rootKept;
    r.bytes = plan.entries.reduce((s, e) => s + e.bytes, 0);
    r.files = plan.entries.reduce((s, e) => s + e.files, 0);
  }
  const todo = run.items.filter((r) => plans.get(r.id)?.entries.length);
  if (opts.dryRun || !db) {
    run.totals = ruleTotals(todo.flatMap((r) => r.entries));
    return run;
  }
  if (!opts.cmd) throw rejected(`no trash command: nothing is pruned (${TRASH_HINT})`);
  retryStaging(ctx, db, opts.cmd, run);
  for (const r of run.items) {
    if (r.skipped || r.entries.length) continue;
    refreshDate(plans.get(r.id)?.dir);
  }
  if (todo.length === 0) return run;
  const staging = stagingDir(root, compact());
  const moved = new Map<string, IEntry[]>();
  for (const r of todo) {
    const plan = plans.get(r.id) as IPlan;
    const applied = stagePrune(plan, join(staging, r.flow, r.id));
    moved.set(r.id, applied.moved);
    r.errors.push(...applied.errors);
  }
  let dest = (r: IItemPrune): string => `trash: ${run.trash}/${r.flow}/${r.id}/`;
  const anyMoved = [...moved.values()].some((m) => m.length);
  if (!anyMoved) {
    // Nothing left the folders (every move failed): the staging folder holds only empty parents.
    removeEmpty(staging);
  } else {
    const t = trash(opts.cmd, staging, ctx.env);
    if (t.ok) run.trash = staging.slice(root.tmp.length + 1);
    else {
      run.staged.push(staging);
      run.warnings.push(`the trash failed; what was pruned is in ${staging} (${t.error})`);
      for (const r of todo) {
        if (moved.get(r.id)?.length) r.errors.push({ path: staging, code: "trash-failed" });
      }
      dest = (r) => `${staging}/${r.flow}/${r.id}/ (the trash failed: it stays in .wip/tmp)`;
    }
  }
  for (const r of todo) {
    const m = moved.get(r.id) ?? [];
    if (!m.length && !r.errors.length) continue;
    const bytes = m.reduce((s, e) => s + e.bytes, 0);
    const files = m.reduce((s, e) => s + e.files, 0);
    const dir = (plans.get(r.id) as IPlan).dir;
    try {
      writeFileSync(join(dir, "prune.md"), pruneMd(r, m, dest(r)));
    } catch (err) {
      r.errors.push({ path: "prune.md", code: (err as NodeJS.ErrnoException).code ?? "write" });
    }
    // A `pruned` milestone says the trash took it: with a failed trash only prune.md records it.
    if (run.trash) {
      run.events.push(
        addEvent(db, {
          itemId: r.id,
          phase: items.find((i) => i.id === r.id)?.phase ?? null,
          kind: "milestone",
          text: `pruned: ${fmtMb(bytes)} MB in ${files} files (trash)`,
          data: {
            name: "pruned",
            rules: ruleTotals(m),
            bytes,
            files,
            rescued: r.rescued.length,
            trash: run.trash,
            errors: r.errors,
          },
        }),
      );
    }
    r.bytes = bytes;
    r.files = files;
    r.entries = m;
  }
  run.totals = ruleTotals(todo.flatMap((r) => moved.get(r.id) ?? []));
  return run;
}

const STAGING_RE = /^wip-prune-\d+(-\d+)?$/;

/** A rerun with nothing new to move stamps its date on the prune.md of the earlier run, which stays as it was. */
function refreshDate(dir: string | undefined): void {
  if (!dir) return;
  const file = join(dir, "prune.md");
  try {
    const text = readFileSync(file, "utf8");
    const next = text.replace(
      /^- Date: (\S+)(?: \(.*\))?$/m,
      (_m, first: string) => `- Date: ${iso()} (rerun, nothing new to prune; first run ${first})`,
    );
    if (next !== text) writeFileSync(file, next);
  } catch {
    // No prune.md (never pruned) or unreadable: nothing to stamp.
  }
}

/**
 * Staging folders left in .wip/tmp by a run whose trash failed: send each to the trash now. The `pruned` milestone of
 * their items is recorded here, as the trash took them, and the Destination of their prune.md is corrected.
 */
function retryStaging(ctx: ICtx, db: TDatabase, cmd: ITrashCmd, run: IPruneRun): void {
  let names: string[];
  try {
    names = readdirSync(ctx.root.tmp).filter((n) => STAGING_RE.test(n));
  } catch {
    return;
  }
  for (const name of names.sort()) {
    const dir = join(ctx.root.tmp, name);
    if (!lstatSync(dir).isDirectory()) continue;
    const held: { id: string; bytes: number; files: number }[] = [];
    for (const flow of readdirSync(dir)) {
      for (const id of readdirSync(join(dir, flow))) {
        held.push({ id, ...measure(join(dir, flow, id)) });
      }
    }
    const t = trash(cmd, dir, ctx.env);
    if (!t.ok) {
      run.staged.push(dir);
      run.warnings.push(`the trash failed again for ${dir} (${t.error})`);
      continue;
    }
    run.retried.push(name);
    for (const h of held) {
      const item = db.query("SELECT * FROM items WHERE id = ?").get(h.id) as IItemRow | null;
      if (!item) continue;
      run.events.push(
        addEvent(db, {
          itemId: h.id,
          phase: item.phase ?? null,
          kind: "milestone",
          text: `pruned: ${fmtMb(h.bytes)} MB in ${h.files} files (trash, retried)`,
          data: { name: "pruned", bytes: h.bytes, files: h.files, trash: name, retried: true },
        }),
      );
      if (item.artifact_dir) fixDestination(join(item.artifact_dir, "prune.md"), name);
    }
  }
}

/** prune.md said the trash had failed: now it says where the trash took it. */
function fixDestination(file: string, name: string): void {
  try {
    const text = readFileSync(file, "utf8");
    const next = text.replace(
      /^- Destination: .*\(the trash failed: it stays in \.wip\/tmp\)$/m,
      `- Destination: trash: ${name} (retried by a later wip prune)`,
    );
    if (next !== text) writeFileSync(file, next);
  } catch {
    // No prune.md: nothing to correct.
  }
}

/** Removes the empty folders of a staging tree (rmdir only: it never removes a file). */
function removeEmpty(dir: string): void {
  if (measure(dir).files > 0) return;
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (lstatSync(p).isDirectory()) walk(p);
    }
    try {
      rmdirSync(d);
    } catch {
      // Not empty: it stays.
    }
  };
  walk(dir);
}

export function renderRun(run: IPruneRun, detail: boolean): string[] {
  const active = run.items.filter((r) => !r.skipped && (r.entries.length || r.errors.length));
  const bytes = active.reduce((s, r) => s + r.bytes, 0);
  const files = active.reduce((s, r) => s + r.files, 0);
  const rescued = run.items.flatMap((r) => r.rescued);
  const where = run.dry_run
    ? "Trash"
    : run.staged.length
      ? "Trash failed (staged in .wip/tmp)"
      : `Trash ${run.trash ?? (run.retried.length ? "(only leftovers retried)" : "(nothing moved)")}`;
  const lines = [
    `PRUNE${run.dry_run ? " --dry-run" : ""} · ${where} · ${active.length} items · ${fmtMb(bytes)} MB in ${files} files · rescues ${rescued.length} (${fmtMb(rescued.reduce((s, r) => s + r.bytes, 0))} MB)`,
  ];
  for (const r of active) {
    lines.push(
      `${r.id} · ${r.flow} · archived ${r.archived_at?.slice(0, 10) ?? "?"} · ${fmtMb(r.bytes)} MB${r.errors.length ? ` · ${r.errors.length} errors` : ""}`,
    );
    lines.push(...ruleLines(r.entries, r.rescued));
    if (detail) {
      lines.push(
        ...entryLines(r.entries, r.rescued, r.kept, r.errors).map((l) => (l ? `    ${l}` : l)),
        "",
      );
    } else for (const e of r.errors) lines.push(`  ERROR ${e.path} · ${e.code}`);
  }
  for (const r of run.items.filter((x) => !x.skipped && x.root_kept.length)) {
    lines.push(`${r.id} · kept at the root: ${r.root_kept.join(", ")} (browser profile)`);
  }
  for (const name of run.retried) lines.push(`RETRY ${name} · sent to the trash`);
  for (const dir of run.staged) lines.push(`STAGED ${dir} · the trash failed`);
  for (const r of run.items.filter((x) => x.skipped)) {
    lines.push(`SKIP ${r.id} · ${r.skipped}${r.artifact_dir ? ` · ${r.artifact_dir}` : ""}`);
  }
  lines.push(`TOTAL  ${RULE_IDS.map((id) => `${id} ${fmtMb(run.totals[id] ?? 0)}`).join(" · ")}`);
  return lines;
}

function run(ctx: ICtx, args: IArgs, db: TDatabase | null): void {
  const all = args.flags.has("archived");
  if (all === args.pos.length > 0)
    throw usage("wip prune <ID> or wip prune --archived (one of the two)");
  noExtra(args, 1);
  if (args.opts.flow !== undefined && !all) throw usage("--flow only goes with --archived");
  const report = args.opts.report;
  if (report !== undefined && !isAbsolute(report)) throw usage("--report needs an absolute path");
  const keep =
    args.opts.keep !== undefined
      ? need(args.opts.keep, "--keep")
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean)
      : [];
  if (all && keep.some((k) => !isAbsolute(k)))
    throw usage("--keep with --archived needs absolute paths");
  const dryRun = args.flags.has("dry-run");
  let items: IItemRow[];
  if (all) {
    const flow = args.opts.flow;
    items = db
      ? ((flow
          ? db
              .query("SELECT * FROM items WHERE status = 'archived' AND flow = ? ORDER BY id")
              .all(flow)
          : db
              .query("SELECT * FROM items WHERE status = 'archived' ORDER BY id")
              .all()) as IItemRow[])
      : [];
  } else {
    const item = getItem(db, need(args.pos[0], "the item ID"));
    if (item.status !== "archived") throw rejected(`${item.id} is open: it is not pruned`);
    const f = folderOf(ctx.root, db, item);
    if ("skip" in f && f.refuse) throw rejected(`${item.id}: ${f.skip}: it is not pruned`);
    items = [item];
  }
  const cmd = trashCommand(ctx.env);
  if (!dryRun && !cmd) throw rejected(`no trash command: nothing is pruned (${TRASH_HINT})`);
  const result = runPrune(ctx, db, items, { dryRun, keep, cmd });
  ctx.result.events.push(...result.events);
  for (const message of result.warnings) ctx.result.warnings.push({ code: "prune", message });
  ctx.result.data = {
    dry_run: result.dry_run,
    items: result.items.map(({ refuse: _refuse, ...r }) => r),
    totals: result.totals,
    trash: result.trash,
    staged: result.staged,
    retried: result.retried,
  };
  ctx.result.lines.push(...renderRun(result, false));
  if (report) {
    writeFileSync(
      report,
      [
        "# wip prune",
        "",
        "```",
        ...renderRun(result, false),
        "```",
        "",
        "## Detail per item",
        "",
        ...renderRun(result, true),
        "",
      ].join("\n"),
    );
  }
  if (result.staged.length || result.items.some((r) => r.errors.length)) {
    ctx.result.ok = false;
    ctx.result.code = EXIT.FINDINGS;
  }
}

export const pruneWrite: IHandler = { db: "write", run: (ctx, args) => run(ctx, args, ctx.db) };
/** `--dry-run`: reads only, so it never creates the database. */
export const pruneRead: IHandler = { db: "read", run: (ctx, args) => run(ctx, args, ctx.readDb) };

/**
 * `wip archive` hook: prune one just-archived item. Returns the status line suffix; warnings go to `ctx`.
 * It never throws and never changes the exit code.
 */
export function pruneItem(ctx: ICtx, item: IItemRow): string {
  try {
    const cmd = trashCommand(ctx.env);
    if (!cmd) {
      ctx.result.warnings.push({
        code: "prune_skipped",
        message: "no prune: no trash command (set WIP_TRASH_CMD)",
      });
      return " · not pruned (no trash command)";
    }
    const f = folderOf(ctx.root, ctx.db, item);
    if ("skip" in f) {
      ctx.result.warnings.push({ code: "prune_skipped", message: `no prune (${f.skip})` });
      return ` · not pruned (${f.skip})`;
    }
    const res = runPrune(ctx, ctx.db, [item], { dryRun: false, keep: [], cmd });
    const r = res.items[0] as IItemPrune;
    ctx.result.events.push(...res.events);
    for (const message of res.warnings) ctx.result.warnings.push({ code: "prune", message });
    if (r.errors.length) {
      ctx.result.warnings.push({
        code: "prune_incomplete",
        message: `prune incomplete (${r.errors.length} errors): repeat with wip prune ${item.id}`,
      });
    }
    if (!r.entries.length && !r.errors.length) return " · nothing to prune";
    if (r.errors.some((e) => e.code === "trash-failed")) {
      return ` · not pruned: ${fmtMb(r.bytes)} MB moved to .wip/tmp, the trash failed`;
    }
    return ` · pruned ${fmtMb(r.bytes)} MB (trash)`;
  } catch (err) {
    ctx.result.warnings.push({
      code: "prune_incomplete",
      message: `prune failed (${(err as Error).message}): repeat with wip prune ${item.id}`,
    });
    return " · not pruned";
  }
}
