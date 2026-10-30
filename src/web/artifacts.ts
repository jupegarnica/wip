import { readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { artifactDir, type IRoot } from "../env.ts";

export const ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
const ARTIFACT_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$/;

export interface IArtifact {
  name: string;
  size: number;
  /** ISO 8601 UTC with milliseconds, from the file's mtime. */
  mtime: string;
  path: string;
}

/** `.wip/items/<flow>/<ID>/` when it is a real directory at that exact place (a link to elsewhere is not). */
export function itemDir(root: IRoot, flow: string, id: string): string | null {
  try {
    const dir = realpathSync(artifactDir(root, flow, id));
    const expected = join(realpathSync(root.items), flow, id);
    return dir === expected && statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/** A regular file directly inside `dir` (after following links), not a dotfile; null otherwise. */
export function artifactFile(dir: string, name: string): string | null {
  if (!ARTIFACT_NAME_RE.test(name) || name.includes("..")) return null;
  try {
    const file = realpathSync(join(dir, name));
    if (dirname(file) !== dir || basename(file).startsWith(".")) return null;
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

export function listArtifacts(root: IRoot, flow: string, id: string): IArtifact[] {
  const dir = itemDir(root, flow, id);
  if (!dir) return [];
  return readdirSync(dir)
    .filter((name) => artifactFile(dir, name) !== null)
    .sort()
    .map((name) => {
      const st = statSync(join(dir, name));
      return { name, size: st.size, mtime: st.mtime.toISOString(), path: join(dir, name) };
    });
}
