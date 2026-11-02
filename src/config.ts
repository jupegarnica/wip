import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rejected } from "./errors.ts";

export const WIP_DIR = ".wip";
export const DEFAULT_DEFS_DIR = ".agents";
export const CONFIG_FILE = "config.json";

export interface IWipConfig {
  /** Relative to the project, or `~/…` in the user's home folder; forward slashes: where agents/ and skills/ live. */
  defs_dir: string;
  harness: string | null;
}

const DEFS_DIR_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export const HOME_PREFIX = "~/";

function isInsideProject(dir: string): boolean {
  return DEFS_DIR_RE.test(dir) && dir.split("/").every((s) => s !== "." && s !== "..");
}

/** A relative path inside the project, or `~/` followed by one (in the user's home folder). */
function isValidDefsDir(dir: string): boolean {
  return isInsideProject(dir.startsWith(HOME_PREFIX) ? dir.slice(HOME_PREFIX.length) : dir);
}

export function configPath(project: string): string {
  return join(project, WIP_DIR, CONFIG_FILE);
}

function invalid(project: string, why: string): Error {
  return rejected(`${WIP_DIR}/${CONFIG_FILE} in ${project} ${why}; fix it or remove it`);
}

/** `null` when the project has no config: its definitions are in `.agents/`. */
export function readConfig(project: string): IWipConfig | null {
  const file = configPath(project);
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw invalid(project, `is not valid JSON (${(err as Error).message})`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid(project, "is not a JSON object");
  }
  const { defs_dir, harness } = raw as Record<string, unknown>;
  if (typeof defs_dir !== "string" || !isValidDefsDir(defs_dir)) {
    throw invalid(
      project,
      "has no valid defs_dir (a relative path inside the project, or ~/<path> in the user's home folder)",
    );
  }
  if (harness !== undefined && harness !== null && typeof harness !== "string") {
    throw invalid(project, "has a harness that is not a string");
  }
  return { defs_dir, harness: harness ?? null };
}

export function defsDirOf(project: string): string {
  return readConfig(project)?.defs_dir ?? DEFAULT_DEFS_DIR;
}

export function writeConfig(project: string, config: IWipConfig): void {
  writeFileSync(configPath(project), `${JSON.stringify(config, null, 2)}\n`);
}
