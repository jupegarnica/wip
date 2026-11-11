import { join } from "node:path";
import { allow, type IArgs } from "../args.ts";
import { BUILD_INFO } from "../build-info.ts";
import { compact } from "../clock.ts";
import { readConfig } from "../config.ts";
import type { ICtx, IHandler } from "../context.ts";
import { KANBAN_MOD } from "../embedded/kanban.ts";
import type { TEnv } from "../env.ts";
import { EXIT, rejected, type TExitCode, usage, WipError } from "../errors.ts";
import type { TSettingsFile } from "../init/claude-settings.ts";
import { KanbanCopyFailed, kanbanPreflight, kanbanState } from "../init/kanban.ts";
import { detectInstall, type IInstallInfo, INSTALL_KIND, type TInstallKind } from "../install.ts";
import { applyMod, type IModResult, preferredSettingsFile } from "../upgrade/mod.ts";
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

const CHANNELS = ["latest", "next"] as const;
type TChannel = (typeof CHANNELS)[number];

const USAGE =
  "usage: wip upgrade [--channel latest|next] [--check | --dry-run] [--kanban | --no-kanban]";

type TAction = "upgraded" | "current" | "available" | "would-upgrade" | "skipped" | "failed";

interface IUpgradeOptions {
  channel: TChannel;
  check: boolean;
  dryRun: boolean;
  kanban: boolean;
  noKanban: boolean;
  applyMod: boolean;
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
  pinned: string | null;
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
  const applyMod = args.flags.has("apply-mod");
  if (check && dryRun) throw usage("--check and --dry-run are exclusive");
  if (kanban && noKanban) throw usage("--kanban and --no-kanban are exclusive");
  if (applyMod && (check || dryRun || args.opts.channel !== undefined)) {
    throw usage("--apply-mod is internal: it takes no --check, --dry-run nor --channel");
  }
  return { channel: value as TChannel, check, dryRun, kanban, noKanban, applyMod };
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

function skippedMod(reason: IModResult["reason"]): IModResult {
  return {
    action: "skipped",
    path: ".claude/skills/wip-kanban/",
    backup: null,
    removed: [],
    settings: null,
    reason,
    warnings: [],
  };
}

function failedMod(backup: string | null): IModResult {
  return {
    action: "failed",
    path: ".claude/skills/wip-kanban/",
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
    pinned?: string | null;
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
    pinned: base.pinned ?? null,
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

function pushModWarnings(ctx: ICtx, mod: IModResult): void {
  for (const warning of mod.warnings) addWarning(ctx, warning.code, warning.message);
}

function modLines(lines: string[], mod: IModResult, project: string | null): void {
  if (mod.action === "updated") {
    lines.push(`kanban: updated ${mod.path}${mod.backup ? ` (backup ${mod.backup})` : ""}`);
  } else if (mod.action === "installed") {
    lines.push(`kanban: installed ${mod.path} (${Object.keys(KANBAN_MOD).length} files)`);
  } else if (mod.action === "exists") {
    lines.push(`kanban: exists ${mod.path}`);
  } else if (mod.action === "failed") {
    lines.push(`kanban: failed${mod.backup ? ` (previous folder at ${mod.backup})` : ""}`);
  } else if (mod.reason === "no-project") {
    lines.push("kanban: skipped (no .wip/ project)");
  } else if (mod.reason === "not-owned") {
    lines.push("kanban: skipped (no wip copy; pass --kanban to install it)");
  }
  for (const removed of mod.removed) lines.push(`removed ${removed}`);
  if (mod.settings !== null && mod.settings.action !== "exists") {
    lines.push(`kanban: settings ${mod.settings.action} ${mod.settings.file}`);
  }
  if (mod.action === "updated" || mod.action === "installed") {
    lines.push("reload plugins or restart Claude Code (/reload-plugins) to load the new pane");
  }
  if (mod.action === "failed" && project !== null) {
    lines.push(`repeat \`wip upgrade\` in ${project}, or run \`wip init --force\``);
  }
}

/** The preflight of an explicit `--kanban`, read only, before npm runs: a refusal exits 3 without upgrading. */
function kanbanPreflightBeforeInstall(ctx: ICtx, project: string): TSettingsFile {
  const file = preferredSettingsFile(kanbanState(project));
  const pre = kanbanPreflight(project, { requested: true, force: true, file });
  if (pre.refusals.length > 0) throw rejected(`nothing installed: ${pre.refusals.join("; ")}`);
  for (const warning of pre.warnings) addWarning(ctx, warning.code, warning.message);
  return file;
}

function applyInProcess(
  ctx: ICtx,
  project: string,
  options: { install: boolean; file?: TSettingsFile },
  propagateRefusals: boolean,
): IModResult {
  try {
    const mod = applyMod(project, { ...options, stamp: compact() });
    pushModWarnings(ctx, mod);
    return mod;
  } catch (err) {
    if (propagateRefusals && err instanceof WipError) throw err;
    const backup = err instanceof KanbanCopyFailed ? err.backup : null;
    const message = err instanceof Error ? err.message : String(err);
    ctx.result.warnings.push({
      code: "kanban_failed",
      message: `kanban_failed: ${message}${backup ? ` (previous folder at ${backup})` : ""}`,
    });
    return failedMod(backup);
  }
}

interface IChildMod {
  mod: IModResult | null;
  problem: string | null;
  unsupported: boolean;
}

/** Runs the freshly installed CLI's `upgrade --apply-mod`, so the mod comes from the new embedded copy. */
function applyWithInstalled(
  ctx: ICtx,
  info: IInstallInfo,
  project: string,
  install: boolean,
): IChildMod {
  if (info.root === null || info.entry === null) {
    return { mod: null, problem: "the installed package has no bin to run", unsupported: false };
  }
  const args = ["upgrade", "--apply-mod", ...(install ? ["--kanban"] : []), "--json"];
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
      mod: null,
      problem: `the installed CLI did not start: ${out.error}`,
      unsupported: false,
    };
  }
  if (out.status === 2 && /unknown (option|command)/.test(text)) {
    return { mod: null, problem: null, unsupported: true };
  }
  if (out.status !== 0) {
    return {
      mod: null,
      problem: `the installed CLI could not refresh the Kanban mod: ${tail(text)}`,
      unsupported: false,
    };
  }
  let body: { data?: { kanban?: IModResult }; warnings?: { code: string; message: string }[] };
  try {
    body = JSON.parse(out.stdout) as typeof body;
  } catch {
    return {
      mod: null,
      problem: `the installed CLI printed no JSON: ${tail(out.stdout)}`,
      unsupported: false,
    };
  }
  for (const warning of body.warnings ?? []) addWarning(ctx, warning.code, warning.message);
  const mod = body.data?.kanban;
  if (mod === undefined || mod === null || typeof mod.action !== "string") {
    return { mod: null, problem: "the installed CLI printed no kanban result", unsupported: false };
  }
  return { mod, problem: null, unsupported: false };
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

function describeModPlan(project: string, install: boolean): string {
  const state = kanbanState(project);
  if (state.copy === "foreign" || state.copy === "not-dir") {
    return install
      ? `kanban: would refuse (${state.copyProblem})`
      : "kanban: would skip (the folder is not wip's)";
  }
  if (state.copy === "missing") {
    return install
      ? "kanban: would install .claude/skills/wip-kanban/ and the enabledPlugins entry"
      : "kanban: would skip (no wip copy; --kanban would install it)";
  }
  return install
    ? "kanban: would refresh .claude/skills/wip-kanban/ and enable the plugin"
    : "kanban: would refresh .claude/skills/wip-kanban/ if its files changed";
}

/** The hidden `--apply-mod`: applies the running code's embedded copy, never npm. Requires a project (exit 4). */
export function applyModCmd(ctx: ICtx, options: { channel: TChannel; kanban: boolean }): void {
  const project = ctx.root.project;
  const mod = applyInProcess(ctx, project, { install: options.kanban }, true);
  const lines = ctx.result.lines;
  lines.push(header(emptyInstall()));
  modLines(lines, mod, project);
  ctx.result.data = dataOf(
    {
      project,
      info: emptyInstall(),
      channel: options.channel,
      target: null,
      update: null,
      action: mod.action === "failed" ? "failed" : "current",
      kanban: mod,
    },
    false,
    false,
  );
  if (mod.action === "failed") {
    ctx.result.ok = false;
    ctx.result.code = EXIT.FINDINGS;
    ctx.result.message = "the Kanban mod could not be updated";
  } else {
    ctx.result.message = "the Kanban mod is up to date";
  }
}

function run(ctx: ICtx, args: IArgs): void {
  allow(args, ["channel", "check", "dry-run", "kanban", "no-kanban", "apply-mod"]);
  const options = parseOptions(args);
  if (options.applyMod) {
    applyModCmd(ctx, options);
    return;
  }

  const platform = process.platform;
  const info = testInstall ?? detectInstall({ env: ctx.env, platform });
  const project = options.noKanban ? null : projectOf(ctx, options.kanban);
  const pinned = options.noKanban ? null : pinnedOf(project, info, ctx.env);
  if (pinned !== null) {
    ctx.result.warnings.push({
      code: "wip_bin_pinned",
      message: `wip_bin_pinned: this project keeps running ${pinned}; wip upgrade does not change wip_bin`,
    });
  }

  const acts = !options.check && !options.dryRun;
  let kanbanFile: TSettingsFile | undefined;
  if (options.kanban && acts && project !== null) {
    kanbanFile = kanbanPreflightBeforeInstall(ctx, project);
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
    ctx.result.data = dataOf(
      {
        project,
        info,
        channel: options.channel,
        target: resolved.target,
        update,
        action: update ? "available" : "current",
        pinned,
      },
      true,
      false,
    );
    ctx.result.ok = !update;
    ctx.result.code = update ? EXIT.FINDINGS : EXIT.OK;
    ctx.result.message = update
      ? `update available: ${resolved.target}`
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
      else lines.push(describeModPlan(project, options.kanban));
    }
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
  let ok = true;
  let code: TExitCode = EXIT.OK;
  let action: TAction = resolved.update ? "upgraded" : "current";
  let modProblem: string | null = null;
  let unsupported = false;

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
        `the CLI stays as npm left it (prefix ${prefix}); the Kanban mod was not touched; run the command above by hand, or with sudo if the prefix needs it`,
      );
      ctx.result.message = `npm install failed: ${problem}`;
    } else {
      const verified = verifyInstalled(info, resolved.target);
      if (verified.ok) {
        lines.push(`upgraded wip ${info.version} -> ${resolved.target} (${options.channel})`);
        if (!options.noKanban) {
          if (project === null) {
            kanban = skippedMod("no-project");
          } else {
            const child = applyWithInstalled(ctx, info, project, options.kanban);
            unsupported = child.unsupported;
            modProblem = child.problem;
            if (child.problem !== null) {
              ctx.result.warnings.push({
                code: "kanban_failed",
                message: `kanban_failed: ${child.problem}; the CLI is new and the Kanban mod is not`,
              });
              kanban = failedMod(null);
            } else if (child.unsupported) {
              kanban = skippedMod(null);
            } else {
              kanban = child.mod ?? skippedMod("no-project");
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
          ? skippedMod("no-project")
          : applyInProcess(ctx, project, { install: options.kanban, file: kanbanFile }, true);
      if (kanban.action === "failed") {
        ok = false;
        code = EXIT.FINDINGS;
      }
    }
  }

  if (unsupported && project !== null) {
    ctx.result.warnings.push({
      code: "kanban_apply_unsupported",
      message: `kanban_apply_unsupported: the installed wip does not know --apply-mod; run \`wip init --force\` in ${project} to refresh the copy`,
    });
    lines.push(
      `kanban: skipped (the installed wip does not know --apply-mod; run \`wip init --force\`)`,
    );
  }
  if (resolved.update && ok && modProblem === null && kanban?.action === "failed") {
    ok = false;
    code = EXIT.FINDINGS;
    ctx.result.warnings.push({
      code: "kanban_failed",
      message: `kanban_failed: the CLI is new and the Kanban mod is not${
        project ? ` (repeat \`wip upgrade\` in ${project}, or run \`wip init --force\`)` : ""
      }`,
    });
  }

  if (!options.noKanban) {
    if (kanban === null) lines.push("kanban: not touched (the CLI was not upgraded)");
    else if (!unsupported) modLines(lines, kanban, project);
  }
  if (resolved.update && ok) {
    lines.push(
      "note: the next command of this version in a project may migrate its database; see docs/upgrade.md",
    );
  }

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
      pinned,
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
