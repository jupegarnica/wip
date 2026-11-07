import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { TEnv } from "./env.ts";

// The system trash, the only destination of `wip prune`. No fallback deletes anything.

export interface ITrashCmd {
  /** The command and its fixed arguments; the folder to trash goes last, or in WIP_TRASH_DIR when `viaEnv`. */
  argv: string[];
  viaEnv: boolean;
}

export const TRASH_HINT =
  "set WIP_TRASH_CMD to an executable that moves its argument to the trash (macOS: /usr/bin/trash; Linux: gio or trash-put on PATH)";

const WINDOWS_SCRIPT =
  "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:WIP_TRASH_DIR, 'OnlyErrorDialogs', 'SendToRecycleBin')";

function onPath(
  name: string,
  env: TEnv,
  exists: (p: string) => boolean,
  windows: boolean,
): string | null {
  const dirs = (env.PATH ?? "").split(windows ? ";" : delimiter).filter(Boolean);
  const names = windows ? [name, `${name}.exe`] : [name];
  for (const dir of dirs) {
    for (const n of names) {
      const candidate = join(dir, n);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The trash command for this host, or null when there is none.
 * `WIP_TRASH_CMD` (one executable path) wins and is never replaced by another when it does not exist.
 */
export function trashCommand(
  env: TEnv,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): ITrashCmd | null {
  const override = env.WIP_TRASH_CMD;
  if (override) return exists(override) ? { argv: [override], viaEnv: false } : null;
  if (platform === "darwin") {
    return exists("/usr/bin/trash") ? { argv: ["/usr/bin/trash"], viaEnv: false } : null;
  }
  if (platform === "win32") {
    const ps = onPath("powershell", env, exists, true);
    return ps
      ? { argv: [ps, "-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT], viaEnv: true }
      : null;
  }
  const gio = onPath("gio", env, exists, false);
  if (gio) return { argv: [gio, "trash"], viaEnv: false };
  const put = onPath("trash-put", env, exists, false);
  return put ? { argv: [put], viaEnv: false } : null;
}

export type TTrashResult = { ok: true } | { ok: false; error: string };

/** One call on `dir`, no shell. Failure returns the error text; nothing else is attempted. */
export function trash(cmd: ITrashCmd, dir: string, env: TEnv = process.env): TTrashResult {
  const [file, ...rest] = cmd.argv as [string, ...string[]];
  try {
    execFileSync(file, cmd.viaEnv ? rest : [...rest, dir], {
      stdio: ["ignore", "ignore", "pipe"],
      env: cmd.viaEnv ? { ...env, WIP_TRASH_DIR: dir } : { ...env },
    });
    return { ok: true };
  } catch (err) {
    const e = err as { stderr?: Buffer; message: string };
    return { ok: false, error: (e.stderr?.toString().trim() || e.message).slice(0, 300) };
  }
}
