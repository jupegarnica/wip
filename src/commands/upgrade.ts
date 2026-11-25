import { join } from "node:path";
import { allow, type IArgs, parseArgs } from "../args.ts";
import { BUILD_INFO } from "../build-info.ts";
import { compact } from "../clock.ts";
import { defsDirOf, HOME_PREFIX, readConfig } from "../config.ts";
import type { IAfterRun, ICtx, IDefsAfterInstall, IHandler } from "../context.ts";
import { defsPath, findRoot, shownDefsDir, type TEnv } from "../env.ts";
import { EXIT, rejected, type TExitCode, usage, WipError } from "../errors.ts";
import type { TSettingsFile } from "../init/claude-settings.ts";
import { applyDefs, defsDrift, type IDefsDrift } from "../init/drift.ts";
import { ModCopyFailed } from "../init/mod-copy.ts";
import { Aborted, askSelect, type IAsker, terminalAsker } from "../init/prompt.ts";
import type { IInitFile } from "../init/scaffold.ts";
import { detectInstall, type IInstallInfo, INSTALL_KIND, type TInstallKind } from "../install.ts";
import {
  formatNotes,
  type IReleaseNotes,
  parseChangelog,
  readChangelog,
  releaseNotes,
} from "../upgrade/changelog.ts";
import {
  applyMod,
  type IModOps,
  type IModResult,
  kanbanOps,
  preferredSettingsFile,
  quietOps,
} from "../upgrade/mod.ts";
import {
  type ISpawnResult,
  installArgs,
  installCommand,
  parseTags,
  runProcess,
  type TRun,
  viewCommand,
} from "../upgrade/npm.ts";
import { compareVersions, isNewer, parseVersion } from "../upgrade/version.ts";
import { COMMANDS } from "./help.ts";

const CHANNELS = ["latest", "next"] as const;
type TChannel = (typeof CHANNELS)[number];

const USAGE =
  "usage: wip upgrade [--channel latest|next] [--check | --dry-run] [--kanban | --no-kanban] [--quiet | --no-quiet] [--apply-defs | --no-defs]";

type TAction = "upgraded" | "current" | "available" | "would-upgrade" | "skipped" | "failed";

interface IUpgradeOptions {
  channel: TChannel;
  check: boolean;
  dryRun: boolean;
  kanban: boolean;
  noKanban: boolean;
  quiet: boolean;
  noQuiet: boolean;
  applyMod: boolean;
  applyDefs: boolean;
  applyDefsAfter: boolean;
  defsStatus: boolean;
  noDefs: boolean;
}

export interface IDefsData {
  action: "current" | "outdated" | "applied" | "skipped";
  /** `defs_dir` as configured; null when there is no project. */
  dir: string | null;
  /** Shown folder; null when there is no project. */
  path: string | null;
  /** The build whose templates were compared. */
  version: string;
  missing: string[];
  changed: string[];
  foreign: string[];
  kept: string[];
  files: { path: string; action: "created" | "replaced"; backup: string | null }[];
  reason: "no-project" | null;
}

export interface IUpgradeData {
  project: string | null;
  install: {
    kind: TInstallKind;
    root: string | null;
    prefix: string | null;
    bin: string | null;
    version: string;
  };
  channel: TChannel;
  target: string | null;
  update: boolean | null;
  check: boolean;
  dry_run: boolean;
  action: TAction;
  npm: { command: string[]; code: number | null } | null;
  rollback: { version: string; command: string[]; code: number | null } | null;
  kanban: {
    action: IModResult["action"];
    path: string;
    backup: string | null;
    removed: string[];
    settings: IModResult["settings"];
    reason: IModResult["reason"];
  } | null;
  quiet: {
    action: IModResult["action"];
    path: string;
    backup: string | null;
    removed: string[];
    settings: IModResult["settings"];
    reason: IModResult["reason"];
  } | null;
  /** The installed package's notes for `(running, target]`; null when it was not read or had none. */
  changelog: (IReleaseNotes & { truncated: boolean }) | null;
  pinned: string | null;
  /** The definitions comparison of this build; null with `--no-defs`. */
  defs: IDefsData | null;
}

// Test-only seams: the handler's two outside worlds. `null` restores the real ones.
let testRunner: TRun | null = null;
let testInstall: IInstallInfo | null = null;

/** Test-only: replace the npm/child runner. Not reachable from the command line. */
export function setUpgradeRunnerForTests(runner: TRun | null): void {
  testRunner = runner;
}

/** Test-only: replace what this process believes its install is. Not reachable from the command line. */
export function setUpgradeInstallForTests(info: IInstallInfo | null): void {
  testInstall = info;
}

function runner(): TRun {
  return testRunner ?? runProcess;
}

function parseOptions(args: IArgs): IUpgradeOptions {
  if (args.pos.length > 0) throw usage(USAGE);
  const value = args.opts.channel ?? "latest";
  if (!(CHANNELS as readonly string[]).includes(value)) {
    throw usage(`--channel: use ${CHANNELS.join(" or ")}`);
  }
  const check = args.flags.has("check");
  const dryRun = args.flags.has("dry-run");
  const kanban = args.flags.has("kanban");
  const noKanban = args.flags.has("no-kanban");
  const quiet = args.flags.has("quiet");
  const noQuiet = args.flags.has("no-quiet");
  const applyMod = args.flags.has("apply-mod");
  const applyDefs = args.flags.has("apply-defs");
  const applyDefsAfter = args.flags.has("apply-defs-after");
  const defsStatus = args.flags.has("defs-status");
  const noDefs = args.flags.has("no-defs");
  if (check && dryRun) throw usage("--check and --dry-run are exclusive");
  if (kanban && noKanban) throw usage("--kanban and --no-kanban are exclusive");
  if (quiet && noQuiet) throw usage("--quiet and --no-quiet are exclusive");
  if (applyDefs && applyMod) throw usage("--apply-defs and --apply-mod are exclusive");
  if (
    applyDefs &&
    (check || dryRun || args.opts.channel !== undefined || kanban || quiet || noDefs)
  ) {
    throw usage(
      "--apply-defs is its own mode: it takes no --check, --dry-run, --channel, --kanban, --quiet nor --no-defs",
    );
  }
  if (applyMod && (check || dryRun || args.opts.channel !== undefined)) {
    throw usage("--apply-mod is internal: it takes no --check, --dry-run nor --channel");
  }
  // `--apply-defs-after` rides on the user's argv (which may carry --kanban/--quiet), so it takes both mods' flags.
  if (applyDefsAfter && (check || dryRun || applyDefs || applyMod || noDefs)) {
    throw usage(
      "--apply-defs-after is internal: it takes no --check, --dry-run, --apply-defs, --apply-mod nor --no-defs",
    );
  }
  if (
    defsStatus &&
    (check ||
      dryRun ||
      kanban ||
      noKanban ||
      quiet ||
      noQuiet ||
      applyMod ||
      applyDefs ||
      applyDefsAfter ||
      noDefs ||
      args.opts.channel !== undefined)
  ) {
    throw usage("--defs-status is internal: it takes no other flag");
  }
  return {
    channel: value as TChannel,
    check,
    dryRun,
    kanban,
    noKanban,
    quiet,
    noQuiet,
    applyMod,
    applyDefs,
    applyDefsAfter,
    defsStatus,
    noDefs,
  };
}

function projectOf(ctx: ICtx, required: boolean): string | null {
  if (required) return ctx.root.project;
  try {
    return ctx.root.project;
  } catch (err) {
    if (err instanceof WipError && err.code === EXIT.NOT_FOUND) return null;
    throw err;
  }
}

function emptyInstall(): IInstallInfo {
  return {
    kind: INSTALL_KIND,
    root: null,
    prefix: null,
    bin: null,
    version: BUILD_INFO.version,
    problem: null,
    entry: null,
  };
}

function installOf(info: IInstallInfo): IUpgradeData["install"] {
  return {
    kind: info.kind,
    root: info.root,
    prefix: info.prefix,
    bin: info.bin,
    version: info.version,
  };
}

function publicMod(mod: IModResult | null): IUpgradeData["kanban"] {
  if (mod === null) return null;
  return {
    action: mod.action,
    path: mod.path,
    backup: mod.backup,
    removed: mod.removed,
    settings: mod.settings,
    reason: mod.reason,
  };
}

function skippedMod(ops: IModOps, reason: IModResult["reason"]): IModResult {
  return {
    action: "skipped",
    path: `${ops.spec.dir}/`,
    backup: null,
    removed: [],
    settings: null,
    reason,
    warnings: [],
  };
}

function failedMod(ops: IModOps, backup: string | null): IModResult {
  return {
    action: "failed",
    path: `${ops.spec.dir}/`,
    backup,
    removed: [],
    settings: null,
    reason: null,
    warnings: [],
  };
}

function dataOf(
  base: {
    project: string | null;
    info: IInstallInfo;
    channel: TChannel;
    target: string | null;
    update: boolean | null;
    action: TAction;
    npm?: IUpgradeData["npm"];
    rollback?: IUpgradeData["rollback"];
    kanban?: IModResult | null;
    quiet?: IModResult | null;
    changelog?: IUpgradeData["changelog"];
    pinned?: string | null;
    defs?: IDefsData | null;
  },
  check: boolean,
  dryRun: boolean,
): IUpgradeData {
  return {
    project: base.project,
    install: installOf(base.info),
    channel: base.channel,
    target: base.target,
    update: base.update,
    check,
    dry_run: dryRun,
    action: base.action,
    npm: base.npm ?? null,
    rollback: base.rollback ?? null,
    kanban: publicMod(base.kanban ?? null),
    quiet: publicMod(base.quiet ?? null),
    changelog: base.changelog ?? null,
    pinned: base.pinned ?? null,
    defs: base.defs ?? null,
  };
}

function tail(text: string, lines = 20): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  const parts = trimmed.split("\n");
  return parts.slice(-lines).join("\n");
}

function npmProblem(out: ISpawnResult): string {
  if (out.error !== null) {
    if (out.error.includes("ENOENT")) return "npm was not found in PATH";
    if (out.error.includes("ETIMEDOUT") || /timed? ?out/i.test(out.error)) return "npm timed out";
    return tail(out.error);
  }
  const detail = tail(out.stderr) || tail(out.stdout);
  return detail === "" ? `npm exited ${out.status}` : detail;
}

function call(
  run: TRun,
  command: string,
  args: string[],
  cwd: string,
  timeout: number,
): ISpawnResult {
  try {
    return run(command, args, { cwd, timeout });
  } catch (err) {
    return { status: null, stdout: "", stderr: "", error: (err as Error).message };
  }
}

export interface ITarget {
  /** The exact version the channel points at. */
  target: string;
  update: boolean;
  /** The channel's version is older than the running one: report it, never install it. */
  older: boolean;
}

/** The channel's exact version and whether it is newer than `current`; throws exit 3 for a missing or invalid tag. */
export function resolveTarget(
  tags: { latest?: string; next?: string },
  channel: TChannel,
  current: string,
): ITarget {
  const raw = tags[channel];
  if (raw === undefined) {
    throw rejected(`the registry has no "${channel}" tag for @garndev/wip; nothing installed`);
  }
  if (parseVersion(raw) === null) {
    throw rejected(`the registry's "${channel}" tag is not a version: ${raw}; nothing installed`);
  }
  if (parseVersion(current) === null) {
    throw rejected(`this build's version is not a version: ${current}; nothing installed`);
  }
  return { target: raw, update: isNewer(raw, current), older: compareVersions(raw, current) < 0 };
}

function header(info: IInstallInfo): string {
  if (info.kind === "npm") {
    return `wip upgrade · ${info.version} · npm${info.prefix ? ` ${info.prefix}` : ""}`;
  }
  if (info.kind === "binary") {
    return `wip upgrade · ${info.version} · binary${info.root ? ` ${info.root}` : ""}`;
  }
  return `wip upgrade · ${info.version} · source`;
}

function displayCommand(argv: readonly string[], platform: string): string {
  if (platform !== "win32") return argv.join(" ");
  return argv.map((part) => (/[\s&|<>^]/.test(part) ? `"${part}"` : part)).join(" ");
}

function npmArgv(prefix: string, version: string): string[] {
  return ["npm", ...installArgs(prefix, version)];
}

export interface IInstallPlan {
  /** The npm argv, as the output and `data.npm.command` show it. */
  command: string[];
  /** The process and arguments to spawn (`cmd.exe` on Windows). */
  spawn: [string, string[]];
}

/** The exact install of `version` into this install's prefix; null for a source run or a binary. */
export function installPlan(
  info: IInstallInfo,
  platform: string,
  version: string,
  env: TEnv = process.env,
): IInstallPlan | null {
  if (info.prefix === null) return null;
  return {
    command: npmArgv(info.prefix, version),
    spawn: installCommand(platform, info.prefix, version, env),
  };
}

/** The npm command a source or binary install would run by hand: no prefix, because wip cannot know it. */
function manualNpmArgv(version: string): string[] {
  return [
    "npm",
    "install",
    "-g",
    "--no-audit",
    "--no-fund",
    "--no-update-notifier",
    "--ignore-scripts",
    `@garndev/wip@${version}`,
  ];
}

function manualCommand(info: IInstallInfo, target: string): string {
  if (info.kind === "binary") {
    return `download wip-${target}-${process.platform}-${process.arch} from the GitHub Release and replace ${info.root ?? "the binary"} (see docs/install.md)`;
  }
  return `npm install -g @garndev/wip@${target}`;
}

function installRefusal(info: IInstallInfo): string | null {
  if (info.kind === "source") {
    return "this is a source run; wip upgrade installs the npm package only: run `npm install -g @garndev/wip@latest`, or run wip upgrade from an npm package or a standalone binary";
  }
  if (info.kind === "binary") {
    return `this is a standalone binary${info.root ? ` (${info.root})` : ""}; wip upgrade does not replace it: download the new archive from the GitHub Release (see docs/install.md)`;
  }
  if (info.prefix === null) {
    return "wip is not installed in an npm global prefix (an npm link or a copy outside node_modules): install it with `npm install -g @garndev/wip@latest`";
  }
  return info.problem;
}

function pinnedOf(project: string | null, info: IInstallInfo, env: ICtx["env"]): string | null {
  if (project === null) return null;
  let pinned: string | null;
  try {
    pinned = readConfig(project)?.wip_bin ?? null;
  } catch {
    return null;
  }
  if (pinned === null) return null;
  const launched = env.WIP_LAUNCH_BIN ?? null;
  if (pinned === info.bin || (launched !== null && pinned === launched)) return null;
  return pinned;
}

/** One warning per code and message: the preflight before the install and the mod step can report the same one. */
function addWarning(ctx: ICtx, code: string, message: string): void {
  if (ctx.result.warnings.some((w) => w.code === code && w.message === message)) return;
  ctx.result.warnings.push({ code, message });
}

function defsLocation(project: string, env: TEnv): { dir: string; shown: string; root: string } {
  const dir = defsDirOf(project);
  return { dir, shown: shownDefsDir(dir, env), root: defsPath(project, dir, env) };
}

function defsDataOf(
  drift: IDefsDrift,
  action: IDefsData["action"],
  files: readonly IInitFile[],
): IDefsData {
  const listed = (kind: "changed" | "missing" | "foreign"): string[] =>
    drift.entries
      .filter((entry) => entry.kind === kind)
      .map((entry) => entry.path)
      .sort();
  return {
    action,
    dir: drift.dir,
    path: drift.path,
    version: BUILD_INFO.version,
    missing: listed("missing"),
    changed: listed("changed"),
    foreign: listed("foreign"),
    kept: [...drift.kept].sort(),
    files: files
      .filter((file) => file.action !== "exists")
      .map((file) => ({
        path: file.path,
        action: (file.action === "created" ? "created" : "replaced") as "created" | "replaced",
        backup: file.backup,
      })),
    reason: null,
  };
}

function defsSkipped(): IDefsData {
  return {
    action: "skipped",
    dir: null,
    path: null,
    version: BUILD_INFO.version,
    missing: [],
    changed: [],
    foreign: [],
    kept: [],
    files: [],
    reason: "no-project",
  };
}

/** The detection of every path that does not write: `outdated` when anything differs, `skipped` without a project. */
function defsDetection(project: string | null, env: TEnv): IDefsData {
  if (project === null) return defsSkipped();
  const location = defsLocation(project, env);
  const data = defsDataOf(defsDrift(location.dir, location.shown, location.root), "current", []);
  if (defsOutdated(data)) data.action = "outdated";
  return data;
}

function defsOutdated(data: IDefsData): boolean {
  return data.changed.length + data.missing.length + data.foreign.length > 0;
}

/** Whether the question has a write to perform: the files `applyDefs` would write and no foreign file that blocks it. */
function defsWritable(data: IDefsData): boolean {
  return data.changed.length + data.missing.length > 0 && data.foreign.length === 0;
}

function defsCount(data: IDefsData): number {
  return data.changed.length + data.missing.length + data.foreign.length;
}

function defsParts(data: IDefsData): string {
  const parts: string[] = [];
  if (data.changed.length > 0) parts.push(`${data.changed.length} changed`);
  if (data.missing.length > 0) parts.push(`${data.missing.length} missing`);
  if (data.foreign.length > 0) parts.push(`${data.foreign.length} foreign`);
  return parts.join(", ");
}

/** The warnings of a comparison, for the handler (through `addWarning`) and for the post-install step. */
function defsWarningList(data: IDefsData): { code: string; message: string }[] {
  const warnings: { code: string; message: string }[] = [];
  const drift = data.changed.length + data.missing.length;
  if (drift > 0) {
    warnings.push({
      code: "defs_outdated",
      message: `defs_outdated: ${drift} ${drift === 1 ? "file differs" : "files differ"} from wip ${data.version} in ${data.path}/ (${defsParts(data)}); run \`wip upgrade --apply-defs\``,
    });
  }
  if (data.foreign.length > 0) {
    const n = data.foreign.length;
    warnings.push({
      code: "defs_foreign",
      message: `defs_foreign: ${n} ${n === 1 ? "file is" : "files are"} another tool's (no \`wip:\` mark) and blocks the refresh: ${data.foreign.join(", ")}; rename or move ${n === 1 ? "it" : "them"} and run \`wip upgrade --apply-defs\``,
    });
  }
  return warnings;
}

function defsWarnings(ctx: ICtx, data: IDefsData): void {
  for (const warning of defsWarningList(data)) addWarning(ctx, warning.code, warning.message);
}

function defsEntryLines(lines: string[], data: IDefsData): void {
  for (const path of data.changed) lines.push(`changed ${path}`);
  for (const path of data.missing) lines.push(`missing ${path}`);
  for (const path of data.foreign) lines.push(`foreign ${path}`);
}

function defsKeptLine(lines: string[], data: IDefsData): void {
  const n = data.kept.length;
  if (n > 0) {
    lines.push(`kept ${n} custom ${n === 1 ? "definition" : "definitions"} (not touched)`);
  }
}

/** Detection on a normal run and on `--check`. */
function defsLines(lines: string[], data: IDefsData): void {
  if (data.action === "skipped" || data.path === null) {
    lines.push("defs: skipped (no .wip/ project)");
    return;
  }
  if (!defsOutdated(data)) {
    lines.push(`defs: up to date (${data.path}/)`);
    return;
  }
  lines.push(
    `defs: ${defsCount(data)} out of date in ${data.path}/ (${defsParts(data)}); run \`wip upgrade --apply-defs\``,
  );
  defsEntryLines(lines, data);
  defsKeptLine(lines, data);
}

/** The plan `--dry-run` prints; writes nothing. */
function defsPlanLines(lines: string[], data: IDefsData): void {
  if (data.action === "skipped" || data.path === null) {
    lines.push("defs: skipped (no .wip/ project)");
    return;
  }
  const writes = data.changed.length + data.missing.length;
  if (!defsOutdated(data)) {
    lines.push(`defs: up to date (${data.path}/)`);
    return;
  }
  if (writes > 0) {
    lines.push(
      `defs: would write ${writes} ${writes === 1 ? "file" : "files"} in ${data.path}/ (${data.changed.length} replaced, ${data.missing.length} created); run \`wip upgrade --apply-defs\` to apply`,
    );
  } else {
    lines.push(
      `defs: cannot write ${data.path}/: ${data.foreign.length} another tool's ${data.foreign.length === 1 ? "file" : "files"} (no \`wip:\` mark)`,
    );
  }
  defsEntryLines(lines, data);
  defsKeptLine(lines, data);
}

/** The result `--apply-defs` prints. */
function defsAppliedLines(lines: string[], data: IDefsData): void {
  if (data.path === null) {
    lines.push("defs: skipped (no .wip/ project)");
    return;
  }
  if (data.action === "current") {
    lines.push(`defs: up to date (${data.path}/); nothing written`);
    return;
  }
  const shared = data.dir?.startsWith(HOME_PREFIX) ?? false;
  lines.push(
    shared
      ? `defs: ${data.path}/ (shared by every --global project; wip ${data.version})`
      : `defs: ${data.path}/ (wip ${data.version})`,
  );
  for (const file of data.files) {
    lines.push(`${file.action} ${file.path}${file.backup ? ` (backup ${file.backup})` : ""}`);
  }
  const created = data.files.filter((file) => file.action === "created").length;
  const replaced = data.files.filter((file) => file.action === "replaced").length;
  const kept = data.kept.length;
  lines.push(
    `defs: ${data.files.length} ${data.files.length === 1 ? "file" : "files"} written (${created} created, ${replaced} replaced)${kept > 0 ? `; ${kept} custom ${kept === 1 ? "definition" : "definitions"} kept` : ""}`,
  );
}

/** The proposal after an npm upgrade: the old build's templates are not the installed version's. */
function defsAfterUpgrade(target: string): string {
  return `defs: run \`wip upgrade --apply-defs\` to compare the definitions with wip ${target}`;
}

/** The comparison the terminal question shows: the summary and the kept line, without the `--apply-defs` tail. */
function defsHintLines(lines: string[], data: IDefsData): void {
  if (data.path === null) return;
  const shared = data.dir?.startsWith(HOME_PREFIX) ?? false;
  const where = shared ? " (shared by every --global project)" : "";
  if (!defsOutdated(data)) {
    lines.push(`defs: up to date (${data.path}/)${where}`);
    return;
  }
  lines.push(`defs: ${defsCount(data)} out of date in ${data.path}/ (${defsParts(data)})${where}`);
  defsKeptLine(lines, data);
}

function pushModWarnings(ctx: ICtx, mod: IModResult): void {
  for (const warning of mod.warnings) addWarning(ctx, warning.code, warning.message);
}

function modLines(
  lines: string[],
  mod: IModResult,
  project: string | null,
  label: string,
  fileCount: number,
): void {
  if (mod.action === "updated") {
    lines.push(`${label}: updated ${mod.path}${mod.backup ? ` (backup ${mod.backup})` : ""}`);
  } else if (mod.action === "installed") {
    lines.push(`${label}: installed ${mod.path} (${fileCount} files)`);
  } else if (mod.action === "exists") {
    lines.push(`${label}: exists ${mod.path}`);
  } else if (mod.action === "failed") {
    lines.push(`${label}: failed${mod.backup ? ` (previous folder at ${mod.backup})` : ""}`);
  } else if (mod.reason === "no-project") {
    lines.push(`${label}: skipped (no .wip/ project)`);
  } else if (mod.reason === "not-owned") {
    lines.push(`${label}: skipped (no wip copy; pass --${label} to install it)`);
  }
  for (const removed of mod.removed) lines.push(`removed ${removed}`);
  if (mod.settings !== null && mod.settings.action !== "exists") {
    lines.push(`${label}: settings ${mod.settings.action} ${mod.settings.file}`);
  }
  if (mod.action === "failed" && project !== null) {
    lines.push(`repeat \`wip upgrade\` in ${project}, or run \`wip init --force\``);
  }
}

/** The preflight of an explicit `--<mod>`, read only, before npm runs: a refusal exits 3 without upgrading. */
function modPreflightBeforeInstall(ctx: ICtx, project: string, ops: IModOps): TSettingsFile {
  const file = preferredSettingsFile(ops.state(project));
  const pre = ops.preflight(project, { requested: true, force: true, file });
  if (pre.refusals.length > 0) throw rejected(`nothing installed: ${pre.refusals.join("; ")}`);
  for (const warning of pre.warnings) addWarning(ctx, warning.code, warning.message);
  return file;
}

function applyInProcess(
  ctx: ICtx,
  project: string,
  ops: IModOps,
  options: { install: boolean; file?: TSettingsFile },
  propagateRefusals: boolean,
): IModResult {
  try {
    const mod = applyMod(ops, project, { ...options, stamp: compact() });
    pushModWarnings(ctx, mod);
    return mod;
  } catch (err) {
    if (propagateRefusals && err instanceof WipError) throw err;
    const backup = err instanceof ModCopyFailed ? err.backup : null;
    const message = err instanceof Error ? err.message : String(err);
    const code = `${ops.spec.warningPrefix}_failed`;
    ctx.result.warnings.push({
      code,
      message: `${code}: ${message}${backup ? ` (previous folder at ${backup})` : ""}`,
    });
    return failedMod(ops, backup);
  }
}

interface IChildMods {
  kanban: IModResult | null;
  quiet: IModResult | null;
  problems: string[];
  unsupported: boolean;
}

/** Runs the freshly installed CLI's `upgrade --apply-mod`, so each mod comes from the new embedded copy. */
function applyWithInstalled(
  ctx: ICtx,
  info: IInstallInfo,
  project: string,
  options: IUpgradeOptions,
): IChildMods {
  const wanted = { kanban: !options.noKanban, quiet: !options.noQuiet };
  if (info.root === null || info.entry === null) {
    return {
      kanban: null,
      quiet: null,
      problems: ["the installed package has no bin to run"],
      unsupported: false,
    };
  }
  const selection = (on: boolean, off: boolean, name: string): string[] =>
    on ? [`--${name}`] : off ? [`--no-${name}`] : [];
  const args = [
    "upgrade",
    "--apply-mod",
    ...selection(options.kanban, options.noKanban, "kanban"),
    ...selection(options.quiet, options.noQuiet, "quiet"),
    "--json",
  ];
  const out = call(
    runner(),
    process.execPath,
    [join(info.root, info.entry), ...args],
    project,
    30_000,
  );
  const text = `${out.stdout}\n${out.stderr}`;
  if (out.error !== null) {
    return {
      kanban: null,
      quiet: null,
      problems: [`the installed CLI did not start: ${out.error}`],
      unsupported: false,
    };
  }
  if (out.status === 2 && /unknown (option|command)/.test(text)) {
    return { kanban: null, quiet: null, problems: [], unsupported: true };
  }
  if (out.status !== 0) {
    return {
      kanban: null,
      quiet: null,
      problems: [`the installed CLI could not refresh the mods: ${tail(text)}`],
      unsupported: false,
    };
  }
  let body: {
    data?: { kanban?: IModResult | null; quiet?: IModResult | null };
    warnings?: { code: string; message: string }[];
  };
  try {
    body = JSON.parse(out.stdout) as typeof body;
  } catch {
    return {
      kanban: null,
      quiet: null,
      problems: [`the installed CLI printed no JSON: ${tail(out.stdout)}`],
      unsupported: false,
    };
  }
  for (const warning of body.warnings ?? []) addWarning(ctx, warning.code, warning.message);
  const problems: string[] = [];
  const read = (value: IModResult | null | undefined, name: string): IModResult | null => {
    if (value === undefined || value === null || typeof value.action !== "string") {
      problems.push(`the installed CLI printed no ${name} result`);
      return null;
    }
    return value;
  };
  const kanban = wanted.kanban ? read(body.data?.kanban, "kanban") : null;
  const quiet = wanted.quiet ? read(body.data?.quiet, "quiet") : null;
  return { kanban, quiet, problems, unsupported: false };
}

function verifyInstalled(
  info: IInstallInfo,
  expected: string,
): { ok: boolean; problem: string | null } {
  if (info.root === null || info.entry === null) {
    return { ok: false, problem: "the package has no bin to run" };
  }
  const out = call(
    runner(),
    process.execPath,
    [join(info.root, info.entry), "version", "--json"],
    info.prefix ?? info.root,
    30_000,
  );
  if (out.error !== null) {
    return { ok: false, problem: `the installed CLI did not start: ${out.error}` };
  }
  if (out.status !== 0) {
    return {
      ok: false,
      problem: `the installed CLI exited ${out.status}: ${tail(out.stderr) || tail(out.stdout)}`,
    };
  }
  try {
    const body = JSON.parse(out.stdout) as { data?: { version?: unknown } };
    const version = body.data?.version;
    return version === expected
      ? { ok: true, problem: null }
      : {
          ok: false,
          problem: `the installed CLI reports ${String(version)} instead of ${expected}`,
        };
  } catch {
    return { ok: false, problem: `the installed CLI printed no JSON: ${tail(out.stdout)}` };
  }
}

function describeModPlan(project: string, ops: IModOps, install: boolean): string {
  const label = ops.spec.warningPrefix;
  const state = ops.state(project);
  if (state.copy === "foreign" || state.copy === "not-dir") {
    return install
      ? `${label}: would refuse (${state.copyProblem})`
      : `${label}: would skip (the folder is not wip's)`;
  }
  if (state.copy === "missing") {
    return install
      ? `${label}: would install ${ops.spec.dir}/ and the enabledPlugins entry`
      : `${label}: would skip (no wip copy; --${label} would install it)`;
  }
  return install
    ? `${label}: would refresh ${ops.spec.dir}/ and enable the plugin`
    : `${label}: would refresh ${ops.spec.dir}/ if its files changed`;
}

/** The hidden `--apply-mod`: applies the running code's embedded copy, never npm. Requires a project (exit 4). */
export function applyModCmd(ctx: ICtx, options: IUpgradeOptions): void {
  const project = ctx.root.project;
  const results: { ops: IModOps; mod: IModResult }[] = [];
  if (!options.noKanban) {
    results.push({
      ops: kanbanOps,
      mod: applyInProcess(ctx, project, kanbanOps, { install: options.kanban }, true),
    });
  }
  if (!options.noQuiet) {
    results.push({
      ops: quietOps,
      mod: applyInProcess(ctx, project, quietOps, { install: options.quiet }, true),
    });
  }
  const byOps = (ops: IModOps): IModResult | null =>
    results.find((entry) => entry.ops === ops)?.mod ?? null;
  const kanban = byOps(kanbanOps);
  const quiet = byOps(quietOps);
  const failed = results.find((entry) => entry.mod.action === "failed") !== undefined;
  const changed = results.some(
    (entry) => entry.mod.action === "updated" || entry.mod.action === "installed",
  );
  const lines = ctx.result.lines;
  lines.push(header(emptyInstall()));
  for (const entry of results) {
    modLines(
      lines,
      entry.mod,
      project,
      entry.ops.spec.warningPrefix,
      Object.keys(entry.ops.files).length,
    );
  }
  if (changed) lines.push("reload plugins or restart Claude Code (/reload-plugins)");
  ctx.result.data = dataOf(
    {
      project,
      info: emptyInstall(),
      channel: options.channel,
      target: null,
      update: null,
      action: failed ? "failed" : "current",
      kanban,
      quiet,
    },
    false,
    false,
  );
  if (failed) {
    ctx.result.ok = false;
    ctx.result.code = EXIT.FINDINGS;
    ctx.result.message = "a mod could not be updated";
  } else {
    ctx.result.message = "the mods are up to date";
  }
}

/**
 * `--apply-defs`: the definitions part of `wip init --force` in place. No registry, no npm, no install refusal; it
 * works from a source run and a binary. Requires a project (exit 4) and refuses a foreign path (exit 3).
 */
function applyDefsCmd(ctx: ICtx, options: IUpgradeOptions): void {
  const project = ctx.root.project;
  const info = testInstall ?? detectInstall({ env: ctx.env, platform: process.platform });
  const done = applyDefs(project, ctx.env, { stamp: compact() });
  const data = defsDataOf(done.drift, done.files.length > 0 ? "applied" : "current", done.files);
  const lines = ctx.result.lines;
  lines.push(header(info));
  defsAppliedLines(lines, data);
  ctx.result.message =
    data.action === "applied"
      ? `definitions written in ${data.path}/`
      : `definitions up to date in ${data.path}/`;
  ctx.result.data = dataOf(
    {
      project,
      info,
      channel: options.channel,
      target: null,
      update: null,
      action: "current",
      defs: data,
    },
    false,
    false,
  );
}

/**
 * The hidden `--defs-status`: the running build's comparison and nothing else. No registry, no npm, no install
 * refusal, no write and no warning; the post-install step runs it in the freshly installed CLI. Requires a project.
 */
function defsStatusCmd(ctx: ICtx, options: IUpgradeOptions): void {
  const project = ctx.root.project;
  const info = testInstall ?? detectInstall({ env: ctx.env, platform: process.platform });
  const data = defsDetection(project, ctx.env);
  const lines = ctx.result.lines;
  lines.push(header(info));
  defsLines(lines, data);
  ctx.result.message =
    data.path === null
      ? "definitions skipped (no .wip/ project)"
      : defsOutdated(data)
        ? `definitions out of date in ${data.path}/`
        : `definitions up to date in ${data.path}/`;
  ctx.result.data = dataOf(
    {
      project,
      info,
      channel: options.channel,
      target: null,
      update: null,
      action: "current",
      defs: data,
    },
    false,
    false,
  );
  ctx.result.code = EXIT.OK;
}

interface IDefsAfter {
  data: IDefsData;
  failed: boolean;
}

function notApplied(ctx: ICtx, problem: string): void {
  ctx.result.warnings.push({
    code: "defs_failed",
    message: `defs_failed: the definitions were not applied: ${problem}; run \`wip upgrade --apply-defs\``,
  });
  ctx.result.lines.push(`defs: not applied (${problem})`);
}

/** Runs the freshly installed CLI's own `upgrade --apply-defs --json`, so the files come from the new embedded copy. */
function installedDefs(
  bin: { root: string | null; entry: string | null },
  project: string,
): { data: IDefsData | null; problem: string | null } {
  if (bin.root === null || bin.entry === null) {
    return { data: null, problem: "the installed package has no bin to run" };
  }
  const out = call(
    runner(),
    process.execPath,
    [join(bin.root, bin.entry), "upgrade", "--apply-defs", "--json"],
    project,
    30_000,
  );
  const text = `${out.stdout}\n${out.stderr}`;
  if (out.error !== null) return { data: null, problem: out.error };
  if (out.status !== 0) {
    return { data: null, problem: tail(text) || `the installed CLI exited ${out.status}` };
  }
  let body: { data?: { defs?: IDefsData } };
  try {
    body = JSON.parse(out.stdout) as typeof body;
  } catch {
    return { data: null, problem: `the installed CLI printed no JSON: ${tail(out.stdout)}` };
  }
  const data = body.data?.defs;
  if (data === undefined || data === null || typeof data.action !== "string") {
    return { data: null, problem: "the installed CLI printed no definitions result" };
  }
  return { data, problem: null };
}

/** Runs the freshly installed CLI's own `upgrade --defs-status --json`: the new build's comparison, no writes. */
function installedDefsStatus(
  bin: { root: string | null; entry: string | null },
  project: string,
): { data: IDefsData | null; problem: string | null } {
  if (bin.root === null || bin.entry === null) {
    return { data: null, problem: "the installed package has no bin to run" };
  }
  const out = call(
    runner(),
    process.execPath,
    [join(bin.root, bin.entry), "upgrade", "--defs-status", "--json"],
    project,
    30_000,
  );
  const text = `${out.stdout}\n${out.stderr}`;
  if (out.error !== null) return { data: null, problem: out.error };
  if (out.status !== 0) {
    return { data: null, problem: tail(text) || `the installed CLI exited ${out.status}` };
  }
  let body: { data?: { defs?: IDefsData } };
  try {
    body = JSON.parse(out.stdout) as typeof body;
  } catch {
    return { data: null, problem: `the installed CLI printed no JSON: ${tail(out.stdout)}` };
  }
  const data = body.data?.defs;
  if (data === undefined || data === null || typeof data.action !== "string") {
    return { data: null, problem: "the installed CLI printed no definitions result" };
  }
  return { data, problem: null };
}

/** The accepted definitions step: the installed build's templates after an upgrade, the running ones otherwise. */
function applyDefsAfter(
  ctx: ICtx,
  info: IInstallInfo,
  project: string,
  update: boolean,
  installOk: boolean,
  detected: IDefsData,
): IDefsAfter {
  const lines = ctx.result.lines;
  if (update && !installOk) {
    lines.push("defs: not applied (the CLI was not upgraded)");
    return { data: detected, failed: false };
  }
  if (update) {
    const child = installedDefs({ root: info.root, entry: info.entry }, project);
    if (child.data === null) {
      notApplied(ctx, child.problem ?? "the installed CLI did not apply them");
      return { data: detected, failed: true };
    }
    defsAppliedLines(lines, child.data);
    return { data: child.data, failed: false };
  }
  try {
    const done = applyDefs(project, ctx.env, { stamp: compact() });
    const data = defsDataOf(done.drift, done.files.length > 0 ? "applied" : "current", done.files);
    defsAppliedLines(lines, data);
    return { data, failed: false };
  } catch (err) {
    if (!(err instanceof WipError)) throw err;
    defsWarnings(ctx, detected);
    ctx.result.warnings.push({
      code: "defs_failed",
      message: `defs_failed: the definitions were not applied: ${err.message}; run \`wip upgrade --apply-defs\``,
    });
    lines.push(`defs: not applied: ${err.message}`);
    return { data: detected, failed: true };
  }
}

const UPGRADE_NO_PROMPT = ["--json", "--help", "-h"];

/** `wip upgrade` asks the definitions question only in a terminal, on a normal run, in a usable install. */
export function isUpgradeDefsPrompt(argv: readonly string[], tty: boolean): boolean {
  if (!tty || argv[0] !== "upgrade") return false;
  const rest = argv.slice(1);
  const dashdash = rest.indexOf("--");
  const head = dashdash < 0 ? rest : rest.slice(0, dashdash);
  if (head.some((a) => UPGRADE_NO_PROMPT.includes(a))) return false;
  const spec = COMMANDS.find((c) => c.name === "upgrade");
  let options: IUpgradeOptions;
  try {
    const args = parseArgs(argv.slice(1), spec?.flags ?? []);
    allow(args, [...(spec?.options ?? []), ...(spec?.flags ?? [])]);
    options = parseOptions(args);
  } catch {
    return false; // the command reports the usage error itself
  }
  return !(
    options.check ||
    options.dryRun ||
    options.noDefs ||
    options.applyDefs ||
    options.applyMod ||
    options.applyDefsAfter ||
    options.defsStatus
  );
}

export interface IUpgradePrompt {
  /** The argv to run: the user's plus `--apply-defs-after`; `null` when nothing is to be upgraded. */
  argv: string[] | null;
  /** 130 on Ctrl+C or end of input. */
  code: number;
  /** Whether the question was actually put to the user (not merely possible). */
  asked: boolean;
}

/** Shows the comparison, asks whether to apply the definitions, and returns the argv for the run. */
export async function promptUpgradeDefs(
  argv: readonly string[],
  cwd: string,
  env: TEnv,
  asker: IAsker = terminalAsker(),
): Promise<IUpgradePrompt> {
  const unchanged: IUpgradePrompt = { argv: [...argv], code: 0, asked: false };
  if (!isUpgradeDefsPrompt(argv, true)) return unchanged;
  const info = testInstall ?? detectInstall({ env, platform: process.platform });
  if (installRefusal(info) !== null) return unchanged; // the run refuses before it could write
  let data: IDefsData;
  try {
    const project = findRoot(cwd, env).project;
    const location = defsLocation(project, env);
    data = defsDataOf(defsDrift(location.dir, location.shown, location.root), "current", []);
    if (defsOutdated(data)) data.action = "outdated";
  } catch {
    return unchanged; // no project, or an unreadable folder: the command reports it
  }
  if (!defsWritable(data)) return unchanged; // nothing to write, or `applyDefs` would refuse the folder
  let asked = false;
  try {
    const hint: string[] = [];
    defsHintLines(hint, data);
    for (const line of hint) asker.say(line);
    const shared = data.dir?.startsWith(HOME_PREFIX) ?? false;
    asked = true;
    const answer = await askSelect(asker, {
      question: "Apply the definitions?",
      initial: 0,
      options: [
        {
          value: "apply",
          label: "apply",
          hint: `write them into ${data.path}/${shared ? " (shared by every --global project)" : ""} with a backup per replaced file; after an upgrade, the installed build's`,
        },
        {
          value: "cancel",
          label: "cancel",
          hint: "leave them as they are; run `wip upgrade --apply-defs` later",
        },
      ],
    });
    if (answer === "apply") return { argv: [...argv, "--apply-defs-after"], code: 0, asked };
    return { ...unchanged, asked };
  } catch (err) {
    if (err instanceof Aborted) {
      asker.say("aborted: nothing upgraded");
      return { argv: null, code: 130, asked };
    }
    throw err;
  } finally {
    asker.close();
  }
}

export interface IDefsAfterInstallResult {
  lines: string[];
  warnings: { code: string; message: string }[];
  code: TExitCode;
}

/**
 * The post-upgrade step: the freshly installed build compares the folder with its own templates and, only when it has
 * files to write, asks the same question. `apply` writes through that build's own `--apply-defs --json`; Ctrl+C is a
 * cancel, because the upgrade already happened.
 */
export async function promptDefsAfterInstall(
  step: IDefsAfterInstall,
  asker: IAsker = terminalAsker(),
): Promise<IDefsAfterInstallResult> {
  const lines: string[] = [];
  const status = installedDefsStatus(step, step.project);
  if (status.data === null) {
    const problem = status.problem ?? "the installed CLI did not compare them";
    lines.push(`defs: not compared (${problem}); run \`wip upgrade --apply-defs\``);
    return { lines, warnings: [], code: EXIT.OK };
  }
  const data = status.data;
  if (data.path === null) {
    lines.push("defs: skipped (no .wip/ project)");
    return { lines, warnings: [], code: EXIT.OK };
  }
  if (!defsWritable(data)) {
    if (!defsOutdated(data)) {
      lines.push(`defs: up to date (${data.path}/) (wip ${data.version})`);
      return { lines, warnings: [], code: EXIT.OK };
    }
    defsLines(lines, data);
    return { lines, warnings: defsWarningList(data), code: EXIT.OK };
  }
  try {
    const hint: string[] = [];
    defsHintLines(hint, data);
    for (const line of hint) asker.say(line);
    const shared = data.dir?.startsWith(HOME_PREFIX) ?? false;
    const answer = await askSelect(asker, {
      question: "Apply the definitions?",
      initial: 0,
      options: [
        {
          value: "apply",
          label: "apply",
          hint: `write them into ${data.path}/${shared ? " (shared by every --global project)" : ""} with a backup per replaced file; after an upgrade, the installed build's`,
        },
        {
          value: "cancel",
          label: "cancel",
          hint: "leave them as they are; run `wip upgrade --apply-defs` later",
        },
      ],
    });
    if (answer === "apply") {
      const child = installedDefs(step, step.project);
      if (child.data === null) {
        const problem = child.problem ?? "the installed CLI did not apply them";
        lines.push(`defs: not applied (${problem}); run \`wip upgrade --apply-defs\``);
        return {
          lines,
          warnings: [
            {
              code: "defs_failed",
              message: `defs_failed: the definitions were not applied: ${problem}; run \`wip upgrade --apply-defs\``,
            },
          ],
          code: EXIT.FINDINGS,
        };
      }
      defsAppliedLines(lines, child.data);
      return { lines, warnings: [], code: EXIT.OK };
    }
    lines.push("defs: left as they are; run `wip upgrade --apply-defs` to write them");
    return { lines, warnings: [], code: EXIT.OK };
  } catch (err) {
    if (err instanceof Aborted) {
      lines.push("defs: left as they are; run `wip upgrade --apply-defs` to write them");
      return { lines, warnings: [], code: EXIT.OK };
    }
    throw err;
  } finally {
    asker.close();
  }
}

function run(ctx: ICtx, args: IArgs): void {
  allow(args, [
    "channel",
    "check",
    "dry-run",
    "kanban",
    "no-kanban",
    "quiet",
    "no-quiet",
    "apply-mod",
    "apply-defs",
    "apply-defs-after",
    "defs-status",
    "no-defs",
  ]);
  const options = parseOptions(args);
  if (options.applyMod) {
    applyModCmd(ctx, options);
    return;
  }
  if (options.applyDefs) {
    applyDefsCmd(ctx, options);
    return;
  }
  if (options.defsStatus) {
    defsStatusCmd(ctx, options);
    return;
  }

  const platform = process.platform;
  const info = testInstall ?? detectInstall({ env: ctx.env, platform });
  const project =
    options.noKanban && options.noQuiet && options.noDefs
      ? null
      : projectOf(ctx, options.kanban || options.quiet || options.applyDefs);
  const pinned = project === null ? null : pinnedOf(project, info, ctx.env);
  if (pinned !== null) {
    ctx.result.warnings.push({
      code: "wip_bin_pinned",
      message: `wip_bin_pinned: this project keeps running ${pinned}; wip upgrade does not change wip_bin`,
    });
  }

  const acts = !options.check && !options.dryRun;
  let kanbanFile: TSettingsFile | undefined;
  let quietFile: TSettingsFile | undefined;
  if (acts && project !== null) {
    if (options.kanban) kanbanFile = modPreflightBeforeInstall(ctx, project, kanbanOps);
    if (options.quiet) quietFile = modPreflightBeforeInstall(ctx, project, quietOps);
  }
  if (acts) {
    const refusal = installRefusal(info);
    if (refusal !== null) throw rejected(refusal);
  }
  const prefix = info.prefix;

  const [viewCmd, viewArgs] = viewCommand(platform, ctx.env);
  const viewed = call(runner(), viewCmd, viewArgs, project ?? ctx.cwd, 30_000);
  if (viewed.error !== null || viewed.status !== 0) {
    throw rejected(`could not check the npm registry: ${npmProblem(viewed)}; nothing installed`);
  }
  let tags: { latest?: string; next?: string };
  try {
    tags = parseTags(viewed.stdout);
  } catch (err) {
    throw rejected(`could not check the npm registry: ${(err as Error).message}`);
  }

  const resolved = resolveTarget(tags, options.channel, info.version);
  const lines = ctx.result.lines;
  lines.push(header(info));
  const defs = options.noDefs ? null : defsDetection(project, ctx.env);

  if (options.check) {
    const update = resolved.update;
    if (update) {
      lines.push(`${options.channel} ${resolved.target}: update available (wip ${info.version})`);
    } else if (resolved.older) {
      lines.push(
        `${options.channel} ${resolved.target}: older than the installed ${info.version}; not downgrading`,
      );
    } else {
      lines.push(`${options.channel} ${resolved.target}: up to date (wip ${info.version})`);
    }
    if (info.kind !== "npm") {
      lines.push(`manual: ${manualCommand(info, resolved.target)}`);
    }
    let outdated = false;
    if (defs !== null) {
      outdated = defsOutdated(defs);
      defsWarnings(ctx, defs);
      defsLines(lines, defs);
    }
    ctx.result.data = dataOf(
      {
        project,
        info,
        channel: options.channel,
        target: resolved.target,
        update,
        action: update ? "available" : "current",
        pinned,
        defs,
      },
      true,
      false,
    );
    ctx.result.ok = !update && !outdated;
    ctx.result.code = update || outdated ? EXIT.FINDINGS : EXIT.OK;
    const count = outdated && defs !== null ? defsCount(defs) : 0;
    const drift =
      count > 0 ? `definitions out of date: ${count} ${count === 1 ? "file" : "files"}` : null;
    ctx.result.message =
      update && drift !== null
        ? `update available: ${resolved.target}; ${drift}`
        : update
          ? `update available: ${resolved.target}`
          : drift !== null
            ? drift
            : `wip ${info.version} is up to date (${options.channel})`;
    return;
  }

  if (options.dryRun) {
    let npm: IUpgradeData["npm"] = null;
    if (resolved.update) {
      const argv =
        installPlan(info, platform, resolved.target, ctx.env)?.command ??
        manualNpmArgv(resolved.target);
      npm = { command: argv, code: null };
      lines.push(`${options.channel} ${resolved.target}: update available (wip ${info.version})`);
      lines.push(displayCommand(argv, platform));
      if (info.kind !== "npm") lines.push(`manual: ${manualCommand(info, resolved.target)}`);
    } else if (resolved.older) {
      lines.push(
        `${options.channel} ${resolved.target}: older than the installed ${info.version}; not downgrading`,
      );
    } else {
      lines.push(`${options.channel} ${resolved.target}: up to date (wip ${info.version})`);
    }
    if (!options.noKanban) {
      if (project === null) lines.push("kanban: skipped (no .wip/ project)");
      else lines.push(describeModPlan(project, kanbanOps, options.kanban));
    }
    if (!options.noQuiet) {
      if (project === null) lines.push("quiet: skipped (no .wip/ project)");
      else lines.push(describeModPlan(project, quietOps, options.quiet));
    }
    if (defs !== null) defsPlanLines(lines, defs);
    ctx.result.data = dataOf(
      {
        project,
        info,
        channel: options.channel,
        target: resolved.target,
        update: resolved.update,
        action: resolved.update ? "would-upgrade" : "current",
        npm,
        pinned,
        defs,
      },
      false,
      true,
    );
    ctx.result.ok = true;
    ctx.result.code = EXIT.OK;
    ctx.result.message = resolved.update
      ? `would install ${resolved.target}`
      : `wip ${info.version} is up to date (${options.channel})`;
    return;
  }

  let npm: IUpgradeData["npm"] = null;
  let rollback: IUpgradeData["rollback"] = null;
  let kanban: IModResult | null = null;
  let quiet: IModResult | null = null;
  let changelog: IUpgradeData["changelog"] = null;
  let ok = true;
  let code: TExitCode = EXIT.OK;
  let action: TAction = resolved.update ? "upgraded" : "current";
  let unsupported = false;
  let installOk = false;

  if (resolved.update) {
    const plan = installPlan(info, platform, resolved.target, ctx.env);
    if (plan === null || prefix === null) {
      throw rejected("wip is not installed in an npm global prefix; nothing installed");
    }
    lines.push(`${options.channel} ${resolved.target}: update available (wip ${info.version})`);
    lines.push(displayCommand(plan.command, platform));
    const installed = call(runner(), plan.spawn[0], plan.spawn[1], project ?? ctx.cwd, 120_000);
    npm = { command: plan.command, code: installed.status };
    if (installed.error !== null || installed.status !== 0) {
      action = "failed";
      ok = false;
      code = EXIT.FINDINGS;
      const problem = npmProblem(installed);
      lines.push(`npm install failed: ${problem}`);
      lines.push(
        `the CLI stays as npm left it (prefix ${prefix}); the mods were not touched; run the command above by hand, or with sudo if the prefix needs it`,
      );
      ctx.result.message = `npm install failed: ${problem}`;
    } else {
      const verified = verifyInstalled(info, resolved.target);
      if (verified.ok) {
        installOk = true;
        lines.push(`upgraded wip ${info.version} -> ${resolved.target} (${options.channel})`);
        const markdown = readChangelog(info.root);
        if (markdown === null) {
          addWarning(
            ctx,
            "changelog_missing",
            `changelog_missing: the installed package ships no CHANGELOG.md; no release notes for ${info.version} -> ${resolved.target}`,
          );
        } else {
          const notes = releaseNotes(parseChangelog(markdown), info.version, resolved.target);
          if (notes === null) {
            addWarning(
              ctx,
              "changelog_empty",
              `changelog_empty: no CHANGELOG.md section between ${info.version} and ${resolved.target}`,
            );
          } else {
            const formatted = formatNotes(notes);
            changelog = { ...notes, truncated: formatted.truncated };
            lines.push("", ...formatted.lines, "");
          }
        }
        if (project === null) {
          if (!options.noKanban) kanban = skippedMod(kanbanOps, "no-project");
          if (!options.noQuiet) quiet = skippedMod(quietOps, "no-project");
        } else if (options.noKanban && options.noQuiet) {
          // Both mod steps are off: no child call at all.
        } else {
          const child = applyWithInstalled(ctx, info, project, options);
          unsupported = child.unsupported;
          const problemText = child.problems.join("; ");
          if (!options.noKanban) {
            if (child.unsupported) {
              kanban = skippedMod(kanbanOps, null);
            } else if (child.problems.length > 0) {
              ctx.result.warnings.push({
                code: "kanban_failed",
                message: `kanban_failed: ${problemText}; the CLI is new and the Kanban mod is not`,
              });
              kanban = failedMod(kanbanOps, null);
            } else {
              kanban = child.kanban ?? skippedMod(kanbanOps, "no-project");
            }
          }
          if (!options.noQuiet) {
            if (child.unsupported) {
              quiet = skippedMod(quietOps, null);
            } else if (child.problems.length > 0) {
              ctx.result.warnings.push({
                code: "quiet_failed",
                message: `quiet_failed: ${problemText}; the CLI is new and the Quiet mod is not`,
              });
              quiet = failedMod(quietOps, null);
            } else {
              quiet = child.quiet ?? skippedMod(quietOps, "no-project");
            }
          }
        }
      } else {
        action = "failed";
        ok = false;
        code = EXIT.FINDINGS;
        lines.push(`the installed CLI did not verify: ${verified.problem}`);
        const [rollbackCmd, rollbackArguments] = installCommand(
          platform,
          prefix,
          info.version,
          ctx.env,
        );
        const restored = call(
          runner(),
          rollbackCmd,
          rollbackArguments,
          project ?? ctx.cwd,
          120_000,
        );
        rollback = {
          version: info.version,
          command: npmArgv(prefix, info.version),
          code: restored.status,
        };
        const restoredVerify =
          restored.error === null && restored.status === 0
            ? verifyInstalled(info, info.version)
            : { ok: false, problem: npmProblem(restored) };
        if (restoredVerify.ok) {
          lines.push(`rolled back to wip ${info.version}`);
          ctx.result.message = `wip ${resolved.target} did not verify; rolled back to ${info.version}`;
        } else {
          lines.push(
            `the rollback to ${info.version} failed: ${restoredVerify.problem}; run \`npm install -g --prefix ${prefix} @garndev/wip@${info.version}\` by hand`,
          );
          ctx.result.message = `wip ${resolved.target} did not verify and the rollback to ${info.version} failed`;
        }
      }
    }
  } else {
    if (resolved.older) {
      lines.push(
        `${options.channel} ${resolved.target}: older than the installed ${info.version}; not downgrading`,
      );
      lines.push(`manual: ${manualCommand(info, resolved.target)}`);
    } else {
      lines.push(`${options.channel} ${resolved.target}: up to date (wip ${info.version})`);
    }
    if (!options.noKanban) {
      kanban =
        project === null
          ? skippedMod(kanbanOps, "no-project")
          : applyInProcess(
              ctx,
              project,
              kanbanOps,
              { install: options.kanban, file: kanbanFile },
              true,
            );
    }
    if (!options.noQuiet) {
      quiet =
        project === null
          ? skippedMod(quietOps, "no-project")
          : applyInProcess(
              ctx,
              project,
              quietOps,
              { install: options.quiet, file: quietFile },
              true,
            );
    }
    if (kanban?.action === "failed" || quiet?.action === "failed") {
      ok = false;
      code = EXIT.FINDINGS;
    }
  }

  if (unsupported && project !== null) {
    if (!options.noKanban) {
      ctx.result.warnings.push({
        code: "kanban_apply_unsupported",
        message: `kanban_apply_unsupported: the installed wip does not know --apply-mod; run \`wip init --force\` in ${project} to refresh the copy`,
      });
    }
    if (!options.noQuiet) {
      ctx.result.warnings.push({
        code: "quiet_apply_unsupported",
        message: `quiet_apply_unsupported: the installed wip does not know --apply-mod; run \`wip init --force\` in ${project} to refresh the copy`,
      });
      ok = false;
      code = EXIT.FINDINGS;
    }
  }
  for (const [mod, name] of [
    [kanban, "kanban"],
    [quiet, "quiet"],
  ] as const) {
    if (!resolved.update || mod?.action !== "failed") continue;
    ok = false;
    code = EXIT.FINDINGS;
    addWarning(
      ctx,
      `${name}_failed`,
      `${name}_failed: the CLI is new and the ${name === "kanban" ? "Kanban" : "Quiet"} mod is not${
        project ? ` (repeat \`wip upgrade\` in ${project}, or run \`wip init --force\`)` : ""
      }`,
    );
  }

  if (!options.noKanban) {
    if (kanban === null) lines.push("kanban: not touched (the CLI was not upgraded)");
    else if (!unsupported) {
      modLines(lines, kanban, project, "kanban", Object.keys(kanbanOps.files).length);
    }
  }
  if (!options.noQuiet) {
    if (quiet === null) lines.push("quiet: not touched (the CLI was not upgraded)");
    else if (!unsupported) {
      modLines(lines, quiet, project, "quiet", Object.keys(quietOps.files).length);
    }
  }
  if (!unsupported) {
    const changed = [kanban, quiet].some(
      (mod) => mod?.action === "updated" || mod?.action === "installed",
    );
    if (changed) lines.push("reload plugins or restart Claude Code (/reload-plugins)");
  }
  let defsData = defs;
  let after: IAfterRun | undefined;
  if (defs !== null) {
    if (project === null) {
      lines.push("defs: skipped (no .wip/ project)");
    } else if (options.applyDefsAfter) {
      const applied = applyDefsAfter(ctx, info, project, resolved.update, installOk, defs);
      defsData = applied.data;
      if (applied.failed) {
        ok = false;
        code = EXIT.FINDINGS;
        ctx.result.message = "the definitions were not applied";
      }
    } else if (!resolved.update) {
      defsWarnings(ctx, defs);
      defsLines(lines, defs);
    } else if (installOk) {
      if (ctx.interactive) {
        after = { defsAfterInstall: { project, root: info.root, entry: info.entry } };
      } else {
        lines.push(defsAfterUpgrade(resolved.target));
      }
    }
  }
  if (resolved.update && ok) {
    lines.push(
      "note: the next command of this version in a project may migrate its database; see docs/upgrade.md",
    );
  }

  if (after !== undefined) ctx.result.after = after;
  ctx.result.data = dataOf(
    {
      project,
      info,
      channel: options.channel,
      target: resolved.target,
      update: resolved.update,
      action,
      npm,
      rollback,
      kanban,
      quiet,
      changelog,
      pinned,
      defs: defsData,
    },
    false,
    false,
  );
  ctx.result.ok = ok;
  ctx.result.code = code;
  if (ok) {
    ctx.result.message = resolved.update
      ? `wip upgraded to ${resolved.target}`
      : `wip ${info.version} is up to date (${options.channel})`;
  }
}

export const upgradeCmd: IHandler = { db: "none", run };
