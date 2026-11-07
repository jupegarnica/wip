#!/usr/bin/env node
// The `wip` command of the npm package @garndev/wip. It prepares Node and then runs the bundled CLI in this same
// process: it checks the Node version, hides the one SQLite ExperimentalWarning Node 22 prints, and tells `wip start`
// which path it was started as. The bundle is imported only afterwards: a static import would load `node:sqlite`
// (and print the warning) before any of this runs.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MIN_NODE = "22.13.0";
export const EXIT_USAGE = 2;

/** True when `version` (`22.16.0`, `v24.1.0`) is older than MIN_NODE. */
export function nodeTooOld(version) {
  const have = version
    .replace(/^v/, "")
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const need = MIN_NODE.split(".").map(Number);
  for (let i = 0; i < need.length; i++) {
    const a = have[i] ?? 0;
    if (a !== need[i]) return a < need[i];
  }
  return false;
}

/** The warning `node:sqlite` emits when it loads on Node 22; every other warning still prints. */
export function isSqliteWarning(warning) {
  const text = typeof warning === "string" ? warning : warning?.message;
  return typeof text === "string" && text.startsWith("SQLite is an experimental feature");
}

export function filterSqliteWarning(proc = process) {
  const emit = proc.emitWarning;
  proc.emitWarning = function emitWarning(warning, ...rest) {
    if (isSqliteWarning(warning)) return;
    return emit.call(proc, warning, ...rest);
  };
}

/**
 * The path `wip start` records as `wip_bin`: the link npm puts on PATH (`bin/wip`, or a renamed one such as `wip2`)
 * as this process was started; a value already set wins. On Windows npm starts this file through a `.cmd` shim and
 * the `.mjs` path is nothing the coordinator can run: nothing is set, and `wip` comes from PATH.
 */
export function launchBin(env, argv, platform) {
  if (env.WIP_LAUNCH_BIN || platform === "win32" || !argv[1]) return null;
  return argv[1];
}

function isEntry() {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  if (nodeTooOld(process.versions.node)) {
    process.stderr.write(`wip needs Node ${MIN_NODE} or later (found ${process.versions.node})\n`);
    process.exit(EXIT_USAGE);
  }
  filterSqliteWarning();
  const bin = launchBin(process.env, process.argv, process.platform);
  if (bin) process.env.WIP_LAUNCH_BIN = bin;
  // Caches the compiled bundle on disk, so the next start is faster.
  const { enableCompileCache } = await import("node:module");
  try {
    enableCompileCache?.();
  } catch {}
  const { main } = await import("../dist/wip.mjs");
  process.exit(await main(process.argv.slice(2)));
}
