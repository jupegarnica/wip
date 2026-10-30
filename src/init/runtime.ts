import { lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const CLAUDE_CODE = "claude-code";

export interface ILink {
  /** Relative to the project, forward slashes. */
  path: string;
  /** As written in the link: relative to the link's directory. */
  target: string;
  action: "created" | "exists";
}

const LINKS: readonly (readonly [string, string])[] = [
  [".claude/agents", ".agents/agents"],
  [".claude/skills", ".agents/skills"],
];

const isWindows = process.platform === "win32";

function linkState(project: string, path: string, target: string): "missing" | "ok" | string {
  const link = join(project, path);
  const stat = lstatSync(link, { throwIfNoEntry: false });
  if (!stat) return "missing";
  if (!stat.isSymbolicLink()) {
    return `${path} is a ${stat.isDirectory() ? "directory" : "file"}, not a link to ${target}; move it away and run init again`;
  }
  const points = resolve(dirname(link), readlinkSync(link));
  if (points === resolve(project, target)) return "ok";
  return `${path} links to ${points}, not to ${target}; remove the link and run init again`;
}

/** Why the Claude Code links cannot be created; empty when they can. */
export function claudeCodeConflicts(project: string): string[] {
  return LINKS.map(([path, target]) => linkState(project, path, target)).filter(
    (state) => state !== "missing" && state !== "ok",
  );
}

/** Relative symlinks; on Windows, directory junctions, which need no administrator rights. */
export function linkClaudeCode(project: string): ILink[] {
  return LINKS.map(([path, target]) => {
    const link = join(project, path);
    const written = relative(dirname(link), join(project, target)).split("\\").join("/");
    if (linkState(project, path, target) === "ok")
      return { path, target: written, action: "exists" };
    mkdirSync(dirname(link), { recursive: true });
    mkdirSync(join(project, target), { recursive: true });
    if (isWindows) symlinkSync(join(project, target), link, "junction");
    else symlinkSync(written, link, "dir");
    return { path, target: written, action: "created" };
  });
}
