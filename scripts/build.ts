import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

interface ITarget {
  os: "darwin" | "linux" | "windows";
  arch: "arm64" | "x64";
}

interface IBuildOptions {
  targets: ITarget[];
  out: string;
  pack: boolean;
}

const ALL_TARGETS: readonly ITarget[] = [
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "arm64" },
  { os: "windows", arch: "x64" },
];

const MB = 1024 * 1024;

const ROOT = resolve(import.meta.dir, "..");
const ENTRY = join(ROOT, "src", "cli.ts");
const MAIN_TEMPLATE = join(ROOT, "npm", "wip");

const targetKey = (target: ITarget): string => `${target.os}-${target.arch}`;
const npmOs = (target: ITarget): string => (target.os === "windows" ? "win32" : target.os);
const binaryName = (target: ITarget): string => (target.os === "windows" ? "wip.exe" : "wip");

function hostTarget(): ITarget {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const target = ALL_TARGETS.find((t) => t.os === os && t.arch === process.arch);
  if (!target)
    throw new Error(`host ${process.platform}-${process.arch} is not a supported target`);
  return target;
}

function parseTargets(value: string): ITarget[] {
  if (value === "all") return [...ALL_TARGETS];
  return value.split(",").map((raw) => {
    const key = raw.trim();
    if (key === "host") return hostTarget();
    const target = ALL_TARGETS.find((t) => targetKey(t) === key);
    if (!target) {
      throw new Error(`unknown target '${key}' (use all, host or ${ALL_TARGETS.map(targetKey)})`);
    }
    return target;
  });
}

function parseArgs(argv: readonly string[]): IBuildOptions {
  const options: IBuildOptions = { targets: [hostTarget()], out: join(ROOT, "dist"), pack: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--pack") {
      options.pack = true;
    } else if (arg === "--targets" && value) {
      options.targets = parseTargets(value);
      i++;
    } else if (arg === "--out" && value) {
      options.out = resolve(value);
      i++;
    } else {
      throw new Error(
        `usage: bun scripts/build.ts [--targets all|host|<os>-<arch>,...] [--out <dir>] [--pack]`,
      );
    }
  }
  return options;
}

function exec(cmd: string[], cwd: string = ROOT): void {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0)
    throw new Error(`command failed (${result.exitCode}): ${cmd.join(" ")}`);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

interface IPackageJson {
  version: string;
  description?: string;
  license?: string;
  repository?: unknown;
  [key: string]: unknown;
}

export interface IGitInfo {
  branch: string | null;
  commit: string | null;
  dirty: boolean | null;
}

export type TGitRunner = (root: string, args: string[]) => string | null;

/** Runs git in `root`; null when git is missing or exits non-zero. */
export const runGit: TGitRunner = (root, args) => {
  try {
    const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
    return result.exitCode === 0 ? result.stdout.toString().trim() : null;
  } catch {
    return null;
  }
};

const sameDir = (a: string, b: string): boolean => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

/** Branch, short commit and dirty flag of the repo whose top level is `root`; null fields when git is unusable. */
export function gitInfo(root: string, git: TGitRunner = runGit): IGitInfo {
  const none: IGitInfo = { branch: null, commit: null, dirty: null };
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (top === null || !sameDir(top, root)) return none;
  const commit = git(root, ["rev-parse", "--short", "HEAD"]) || null;
  const abbrev = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = commit === null || abbrev === null || abbrev === "HEAD" ? null : abbrev || null;
  const status = git(root, ["status", "--porcelain"]);
  return { branch, commit, dirty: status === null ? null : status.length > 0 };
}

/** `SOURCE_DATE_EPOCH` (integer seconds) when valid, else `now`; ISO 8601 UTC without milliseconds. */
export function buildDate(env: Record<string, string | undefined>, now: Date): string {
  const raw = env.SOURCE_DATE_EPOCH;
  const epoch = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) * 1000 : Number.NaN;
  const date = Number.isFinite(epoch) ? new Date(epoch) : now;
  return `${date.toISOString().slice(0, 19)}Z`;
}

/** The value of `--define WIP_BUILD_INFO=…`: the info as a JSON string literal holding a JSON object. */
export function buildInfoDefine(info: IGitInfo & { built_at: string }): string {
  return JSON.stringify(JSON.stringify(info));
}

function buildPlatform(target: ITarget, out: string, root: IPackageJson, define: string): number {
  const key = targetKey(target);
  const dir = join(out, "npm", `wip-${key}`);
  const binary = join(dir, "bin", binaryName(target));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "bin"), { recursive: true });

  exec([
    process.execPath,
    "build",
    "--compile",
    "--minify",
    `--target=bun-${key}`,
    "--define",
    `WIP_BUILD_INFO=${define}`,
    ENTRY,
    "--outfile",
    binary,
  ]);
  chmodSync(binary, 0o755);

  if (target.os === "darwin" && process.platform === "darwin") {
    exec(["codesign", "--force", "--sign", "-", binary]);
  }

  writeJson(join(dir, "package.json"), {
    name: `@garndev/wip-${key}`,
    version: root.version,
    private: true,
    description: `The ${key} binary of @garndev/wip`,
    license: root.license,
    repository: root.repository,
    os: [npmOs(target)],
    cpu: [target.arch],
    files: ["bin"],
  });

  return statSync(binary).size;
}

function buildMain(out: string, root: IPackageJson): void {
  const dir = join(out, "npm", "wip");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  copyFileSync(join(MAIN_TEMPLATE, "bin", "wip.js"), join(dir, "bin", "wip.js"));
  chmodSync(join(dir, "bin", "wip.js"), 0o755);

  const template = readJson<IPackageJson>(join(MAIN_TEMPLATE, "package.json"));
  const optionalDependencies = Object.fromEntries(
    ALL_TARGETS.map((t) => [`@garndev/wip-${targetKey(t)}`, root.version]),
  );
  writeJson(join(dir, "package.json"), {
    ...template,
    version: root.version,
    optionalDependencies,
  });
}

function pack(out: string, packageDirs: string[]): void {
  for (const dir of packageDirs) {
    exec(
      [
        process.platform === "win32" ? "npm.cmd" : "npm",
        "pack",
        "--silent",
        "--pack-destination",
        out,
      ],
      dir,
    );
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const root = readJson<IPackageJson>(join(ROOT, "package.json"));
  mkdirSync(options.out, { recursive: true });

  const define = buildInfoDefine({
    ...gitInfo(ROOT),
    built_at: buildDate(process.env, new Date()),
  });

  const sizes: [string, number][] = [];
  for (const target of options.targets) {
    sizes.push([targetKey(target), buildPlatform(target, options.out, root, define)]);
  }
  buildMain(options.out, root);

  if (options.pack) {
    const dirs = [
      join(options.out, "npm", "wip"),
      ...options.targets.map((t) => join(options.out, "npm", `wip-${targetKey(t)}`)),
    ];
    pack(options.out, dirs);
  }

  for (const [key, size] of sizes) {
    console.log(`${key.padEnd(14)} ${(size / MB).toFixed(1)} MB`);
  }
}

if (import.meta.main) {
  main();
}
