import { spawnSync } from "node:child_process";
import type { TEnv } from "../env.ts";
import { npmCommandFor, quoteWin } from "../install.ts";

export interface ISpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** A failure to start, or a timeout: `status` is null then. */
  error: string | null;
}

export type TRun = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number },
) => ISpawnResult;

const MB = 1024 * 1024;

/** The real runner: piped, 10 MB of output, no shell, no interactive prompt. */
export const runProcess: TRun = (command, args, options) => {
  try {
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      timeout: options.timeout,
      encoding: "utf8",
      maxBuffer: 10 * MB,
      windowsHide: true,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error ? result.error.message : null,
    };
  } catch (err) {
    return { status: null, stdout: "", stderr: "", error: (err as Error).message };
  }
};

function windowsShell(env: TEnv): string {
  return env.ComSpec ?? env.COMSPEC ?? "cmd.exe";
}

function windowsCommand(env: TEnv, npm: string, args: string[]): [string, string[]] {
  return [windowsShell(env), ["/d", "/s", "/c", npm, ...args.map(quoteWin)]];
}

/** `npm view @garndev/wip dist-tags --json`; on Windows through `cmd.exe`, which runs the `.cmd` shim. */
export function viewCommand(
  platform: string = process.platform,
  env: TEnv = process.env,
): [string, string[]] {
  const args = ["view", "@garndev/wip", "dist-tags", "--json"];
  return platform === "win32" ? windowsCommand(env, npmCommandFor(platform), args) : ["npm", args];
}

/** The npm arguments of an install of one exact version into `prefix`. `--ignore-scripts` is defence in depth. */
export function installArgs(prefix: string, version: string): string[] {
  return [
    "install",
    "-g",
    "--prefix",
    prefix,
    "--no-audit",
    "--no-fund",
    "--no-update-notifier",
    "--ignore-scripts",
    `@garndev/wip@${version}`,
  ];
}

/** The process and arguments of that install; on Windows through `cmd.exe`. */
export function installCommand(
  platform: string,
  prefix: string,
  version: string,
  env: TEnv = process.env,
): [string, string[]] {
  const args = installArgs(prefix, version);
  return platform === "win32" ? windowsCommand(env, npmCommandFor(platform), args) : ["npm", args];
}

/** The `latest` and `next` dist-tags of `npm view … --json`; throws when npm printed something else. */
export function parseTags(stdout: string): { latest?: string; next?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new Error("npm printed no JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("npm printed no dist-tags object");
  }
  const tags = raw as Record<string, unknown>;
  const out: { latest?: string; next?: string } = {};
  if (typeof tags.latest === "string") out.latest = tags.latest;
  if (typeof tags.next === "string") out.next = tags.next;
  return out;
}
