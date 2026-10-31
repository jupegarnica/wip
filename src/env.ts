import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defsDirOf, WIP_DIR } from "./config.ts";
import { notFound } from "./errors.ts";

export { WIP_DIR };

export type TEnv = Readonly<Record<string, string | undefined>>;

export interface IRoot {
  /** The project directory that holds `.wip/`. */
  project: string;
  wip: string;
  db: string;
  items: string;
  backups: string;
  tmp: string;
  /** Relative to the project, forward slashes: `.agents` unless `.wip/config.json` says otherwise. */
  defsDir: string;
  agents: string;
  skills: string;
}

export const FLOW_SKILL_PREFIX = "wip-flow-";

/** Where a flow's file lives, relative to the project. */
export function flowPath(defsDir: string, flow: string): string {
  return `${defsDir}/skills/${FLOW_SKILL_PREFIX}${flow}/SKILL.md`;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function rootAt(project: string): IRoot {
  const wip = join(project, WIP_DIR);
  const defsDir = defsDirOf(project);
  return {
    project,
    wip,
    db: join(wip, "wip.sqlite"),
    items: join(wip, "items"),
    backups: join(wip, "backups"),
    tmp: join(wip, "tmp"),
    defsDir,
    agents: join(project, defsDir, "agents"),
    skills: join(project, defsDir, "skills"),
  };
}

/**
 * The nearest `.wip/` from `cwd` upwards. `WIP_HOME` replaces the search only when it holds a `.wip/`:
 * an inherited `WIP_HOME` that points elsewhere fails instead of sending writes to another tree.
 */
export function findRoot(cwd: string, env: TEnv): IRoot {
  const home = env.WIP_HOME;
  if (home) {
    const project = resolve(cwd, home);
    if (isDirectory(join(project, WIP_DIR))) return rootAt(project);
    throw notFound(
      `WIP_HOME=${home} has no ${WIP_DIR}/ directory; unset WIP_HOME or run \`wip init ${home}\``,
    );
  }
  let dir = resolve(cwd);
  while (true) {
    if (isDirectory(join(dir, WIP_DIR))) return rootAt(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw notFound(
    `no ${WIP_DIR}/ directory in ${resolve(cwd)} or its parents; run \`wip init\` to create one`,
  );
}

export function artifactDir(root: IRoot, flow: string, id: string): string {
  return join(root.items, flow, id);
}
