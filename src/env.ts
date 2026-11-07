import { statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { defsDirOf, HOME_PREFIX, WIP_DIR } from "./config.ts";
import { notFound, rejected } from "./errors.ts";

export { HOME_PREFIX, WIP_DIR };

export type TEnv = Readonly<Record<string, string | undefined>>;

export interface IRoot {
  /** The project directory that holds `.wip/`. */
  project: string;
  wip: string;
  db: string;
  items: string;
  backups: string;
  tmp: string;
  /** As shown in messages: relative to the project, or `~/…`; `.claude` unless `.wip/config.json` says otherwise. */
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

/** Where the definitions folder is on disk: `~/…` under the user's home folder, anything else under the project. */
export function defsPath(project: string, defsDir: string, env: TEnv): string {
  if (!defsDir.startsWith(HOME_PREFIX)) return join(project, defsDir);
  const home = env.HOME || env.USERPROFILE;
  if (!home || !isAbsolute(home)) {
    throw rejected(`defs_dir ${defsDir} needs HOME (the user's home folder)`);
  }
  return join(home, defsDir.slice(HOME_PREFIX.length));
}

/**
 * How a message names a definitions folder: as it is when it is under the project, else the absolute folder `~/…` resolves to
 * from HOME, so a run with another HOME never claims to write to the user's `~/`. `defs_dir` in the config keeps `~/`.
 * (Bun's `os.userInfo().homedir` follows HOME too, so wip cannot tell the account's home from an overridden one.)
 */
export function shownDefsDir(defsDir: string, env: TEnv): string {
  if (!defsDir.startsWith(HOME_PREFIX)) return defsDir;
  const home = env.HOME || env.USERPROFILE;
  if (!home || !isAbsolute(home)) return defsDir;
  return join(home, defsDir.slice(HOME_PREFIX.length));
}

export function rootAt(project: string, env: TEnv = {}): IRoot {
  const wip = join(project, WIP_DIR);
  const defsDir = defsDirOf(project);
  const defs = defsPath(project, defsDir, env);
  return {
    project,
    wip,
    db: join(wip, "wip.sqlite"),
    items: join(wip, "items"),
    backups: join(wip, "backups"),
    tmp: join(wip, "tmp"),
    defsDir,
    agents: join(defs, "agents"),
    skills: join(defs, "skills"),
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
    if (isDirectory(join(project, WIP_DIR))) return rootAt(project, env);
    throw notFound(
      `WIP_HOME=${home} has no ${WIP_DIR}/ directory; unset WIP_HOME or run \`wip init ${home}\``,
    );
  }
  let dir = resolve(cwd);
  while (true) {
    if (isDirectory(join(dir, WIP_DIR))) return rootAt(dir, env);
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
