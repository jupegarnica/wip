import { DEFAULT_DEFS_DIR } from "../config.ts";

export const CLAUDE_CODE = "claude-code";

/** Harnesses that read agents and skills from a folder of their own: wip writes straight there. */
const NATIVE_DEFS_DIRS: Readonly<Record<string, string>> = {
  [CLAUDE_CODE]: ".claude",
};

export function nativeDefsDir(harness: string | null): string | null {
  return harness === null ? null : (NATIVE_DEFS_DIRS[harness] ?? null);
}

export function defsDirFor(harness: string | null): string {
  return nativeDefsDir(harness) ?? DEFAULT_DEFS_DIR;
}
