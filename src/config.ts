import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rejected, usage } from "./errors.ts";

export const WIP_DIR = ".wip";
export const DEFAULT_DEFS_DIR = ".claude";
export const CONFIG_FILE = "config.json";

/** The start command wip proposes when a project has none saved: Claude Code runs the coordinator agent. */
export const DEFAULT_START = ["claude", "--agent", "wip", "--name", "wip-{stamp}"];

/** A copy of `DEFAULT_START`, so a caller cannot change the constant. */
export function defaultStart(): string[] {
  return [...DEFAULT_START];
}

export interface IWipConfig {
  /** Relative to the project, or `~/…` in the user's home folder; forward slashes: where agents/ and skills/ live. */
  defs_dir: string;
  /** Optional: the `wip` binary the coordinator runs for this project (absolute, `~/…`, or relative to the project); `null` means `wip` from the PATH. */
  wip_bin: string | null;
}

/** What `writeConfig` may change: `undefined` leaves a key alone; `null` removes `wip_bin` and `start`. */
export interface IConfigPatch {
  defs_dir?: string;
  wip_bin?: string | null;
  start?: string[] | null;
}

/** The variables a `start` template may use; anything else in braces is an error. */
export const START_VARIABLES = ["stamp", "project", "root", "defs"] as const;
export type TStartVariable = (typeof START_VARIABLES)[number];

export type TStartPiece = { literal: string } | { variable: TStartVariable };

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

function readRaw(project: string): Record<string, unknown> | null {
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
  return raw as Record<string, unknown>;
}

/** `null` when the project has no config: its definitions are in `.claude/`. */
export function readConfig(project: string): IWipConfig | null {
  const raw = readRaw(project);
  if (raw === null) return null;
  const { defs_dir, wip_bin } = raw;
  if (typeof defs_dir !== "string" || !isValidDefsDir(defs_dir)) {
    throw invalid(
      project,
      "has no valid defs_dir (a relative path inside the project, or ~/<path> in the user's home folder)",
    );
  }
  if (
    wip_bin !== undefined &&
    wip_bin !== null &&
    (typeof wip_bin !== "string" || wip_bin.trim() === "")
  ) {
    throw invalid(project, "has a wip_bin that is not a non-empty string");
  }
  return {
    defs_dir,
    wip_bin: (wip_bin as string | null | undefined) ?? null,
  };
}

/** The definitions folder of a project: `defs_dir`, or `.claude` when there is no config. */
export function defsDirOf(project: string): string {
  return readConfig(project)?.defs_dir ?? DEFAULT_DEFS_DIR;
}

/**
 * One tokenizer for `start` templates, used by validation and by expansion, so a value that
 * `--set` accepts is always one that `--dry-run` can expand. `{{` and `}}` are literal braces;
 * `{name}` must name a variable; a lone brace is an error.
 */
const TOKEN_RE = /\{\{|\}\}|\{([A-Za-z]*)\}|[{}]/g;

export function parseStartTemplate(text: string): TStartPiece[] {
  const pieces: TStartPiece[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const at = m.index ?? 0;
    if (at > last) pieces.push({ literal: text.slice(last, at) });
    last = at + m[0].length;
    const token = m[0];
    if (token === "{{") pieces.push({ literal: "{" });
    else if (token === "}}") pieces.push({ literal: "}" });
    else if (token === "{" || token === "}") {
      throw usage(`stray ${token} in "${text}": write {{ or }} for a literal brace`);
    } else {
      const name = m[1] ?? "";
      if (!(START_VARIABLES as readonly string[]).includes(name)) {
        throw usage(
          `unknown variable {${name}} in "${text}"; the variables are ${START_VARIABLES.map((v) => `{${v}}`).join(", ")}`,
        );
      }
      pieces.push({ variable: name as TStartVariable });
    }
  }
  if (last < text.length) pieces.push({ literal: text.slice(last) });
  return pieces;
}

/** A `start` value: a non-empty array of non-empty argument templates. Throws a usage error otherwise. */
export function validateStart(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw usage('start must be a non-empty array of arguments, e.g. ["claude", "--agent", "wip"]');
  }
  value.forEach((arg, i) => {
    if (typeof arg !== "string" || arg === "") {
      throw usage(`start element ${i} must be a non-empty string`);
    }
    parseStartTemplate(arg);
  });
  return value as string[];
}

/** The configured `start` of a project, or `null` when the key is absent. Throws when the key is present and invalid. */
export function readStart(project: string): string[] | null {
  const raw = readRaw(project);
  if (raw === null || raw.start === undefined || raw.start === null) return null;
  try {
    return validateStart(raw.start);
  } catch (err) {
    throw invalid(project, `has an invalid start (${(err as Error).message})`);
  }
}

/**
 * Writes the config merged with `patch`: keys wip does not know (such as `start`) are kept, and the file is
 * replaced atomically through a temporary file in `.wip/`. A legacy `harness` key is dropped.
 */
export function writeConfig(project: string, patch: IConfigPatch): void {
  const merged: Record<string, unknown> = {
    defs_dir: DEFAULT_DEFS_DIR,
    ...(readRaw(project) ?? {}),
  };
  delete merged.harness;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null && (key === "wip_bin" || key === "start")) delete merged[key];
    else merged[key] = value;
  }
  const file = configPath(project);
  const tmp = join(project, WIP_DIR, `${CONFIG_FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`);
  renameSync(tmp, file);
}
