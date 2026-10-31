import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const ARTIFACT_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/;

export function isArtifactName(name: string): boolean {
  return ARTIFACT_NAME_RE.test(name) && !name.includes("..");
}

/** A regular file directly inside `dir` (after following links), not a dotfile; null otherwise. */
export function artifactFile(dir: string, name: string): string | null {
  if (!isArtifactName(name)) return null;
  try {
    const file = realpathSync(join(dir, name));
    if (dirname(file) !== dir || basename(file).startsWith(".")) return null;
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}
