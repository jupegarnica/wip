import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

interface ITarget {
  os: "darwin" | "linux" | "windows";
  arch: "arm64" | "x64";
}

interface IBuildOptions {
  /** Binaries to compile besides the Node package; none by default. */
  targets: ITarget[];
  out: string;
  pack: boolean;
  binName: string;
}

const ALL_TARGETS: readonly ITarget[] = [
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "arm64" },
  { os: "windows", arch: "x64" },
];

export const DEFAULT_BIN_NAME = "wip";
/** The files `npm publish` ships from `<out>/npm/wip/`; the build fails when the package holds anything else. */
export const PACKAGE_FILES = [
  "LICENSE",
  "README.md",
  "bin/wip.mjs",
  "dist/wip.mjs",
  "package.json",
];

const MB = 1024 * 1024;

const ROOT = resolve(import.meta.dir, "..");
/** Exports `main`: the entry of the Node bundle, which `bin/wip.mjs` imports. */
const LIBRARY_ENTRY = join(ROOT, "src", "cli.ts");
/** Runs `main`: the entry of the compiled binary. */
const BINARY_ENTRY = join(ROOT, "src", "main.ts");
const PACKAGE_TEMPLATE = join(ROOT, "npm", "wip");

const targetKey = (target: ITarget): string => `${target.os}-${target.arch}`;
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
  const options: IBuildOptions = {
    targets: [],
    out: join(ROOT, "dist"),
    pack: false,
    binName: DEFAULT_BIN_NAME,
  };
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
    } else if (arg === "--bin-name" && value && /^[a-z][a-z0-9-]*$/.test(value)) {
      options.binName = value;
      i++;
    } else {
      throw new Error(
        "usage: bun scripts/build.ts [--targets all|host|<os>-<arch>,...] [--out <dir>] [--bin-name <name>] [--pack]",
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

/** The value of `--define WIP_INSTALL=…`: what `wip upgrade` may replace, and `version --json` reports. */
export function installDefine(kind: "npm" | "binary"): string {
  return `WIP_INSTALL="${kind}"`;
}

/** Compiles the standalone binary for `target` into `<out>/bin/<os>-<arch>/`; returns its path. */
function buildBinary(target: ITarget, out: string, define: string): string {
  const dir = join(out, "bin", targetKey(target));
  const binary = join(dir, binaryName(target));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  exec([
    process.execPath,
    "build",
    "--compile",
    "--minify",
    `--target=bun-${targetKey(target)}`,
    "--define",
    `WIP_BUILD_INFO=${define}`,
    "--define",
    installDefine("binary"),
    BINARY_ENTRY,
    "--outfile",
    binary,
  ]);
  chmodSync(binary, 0o755);
  if (target.os === "darwin" && process.platform === "darwin") {
    exec(["codesign", "--force", "--sign", "-", binary]);
  }
  return binary;
}

/** `wip-<version>-<os>-<arch>.tar.gz`, or `.zip` for Windows: the name of a GitHub Release asset. */
export function archiveName(version: string, target: ITarget): string {
  return `wip-${version}-${targetKey(target)}.${target.os === "windows" ? "zip" : "tar.gz"}`;
}

/** Archives the binary of `target` into `<out>/release/`, with only the binary at the top; returns the archive path. */
function archiveBinary(binary: string, target: ITarget, out: string, version: string): string {
  const dir = join(out, "release");
  mkdirSync(dir, { recursive: true });
  const archive = join(dir, archiveName(version, target));
  rmSync(archive, { force: true });
  if (target.os === "windows") exec(["zip", "-j", "-q", archive, binary]);
  else exec(["tar", "-czf", archive, "-C", dirname(binary), basename(binary)]);
  return archive;
}

/** The `SHA256SUMS` text (`<hex>  <name>` per line, sorted by name) for `files`, as `shasum -a 256 -c` reads it. */
export function sha256sums(files: readonly string[]): string {
  return [...files]
    .sort((a, b) => basename(a).localeCompare(basename(b)))
    .map(
      (file) =>
        `${createHash("sha256").update(readFileSync(file)).digest("hex")}  ${basename(file)}\n`,
    )
    .join("");
}

/** The package.json of the npm package: the template with the version and the command name `binName`. */
export function mainPackageJson(
  template: IPackageJson,
  version: string,
  binName: string = DEFAULT_BIN_NAME,
): IPackageJson {
  const bin = Object.values(template.bin as Record<string, string>)[0] ?? "bin/wip.mjs";
  return { ...template, version, bin: { [binName]: bin } };
}

/** Every file under `dir`, relative to it with `/`, sorted. */
export function listFiles(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? listFiles(dir, rel) : [rel];
    })
    .sort();
}

/**
 * The npm package in `<out>/npm/wip/`: the Node bundle of src/ (migrations, templates, the web page, yaml and
 * @garndev/markdown inlined), the bin that runs it, README and LICENSE. No dependencies and no platform packages.
 */
function buildPackage(out: string, root: IPackageJson, binName: string, define: string): string {
  const dir = join(out, "npm", "wip");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  exec([
    process.execPath,
    "build",
    LIBRARY_ENTRY,
    "--target=node",
    "--format=esm",
    "--define",
    `WIP_BUILD_INFO=${define}`,
    "--define",
    installDefine("npm"),
    "--outfile",
    join(dir, "dist", "wip.mjs"),
  ]);
  copyFileSync(join(PACKAGE_TEMPLATE, "bin", "wip.mjs"), join(dir, "bin", "wip.mjs"));
  chmodSync(join(dir, "bin", "wip.mjs"), 0o755);
  copyFileSync(join(ROOT, "README.md"), join(dir, "README.md"));
  copyFileSync(join(ROOT, "LICENSE"), join(dir, "LICENSE"));
  const template = readJson<IPackageJson>(join(PACKAGE_TEMPLATE, "package.json"));
  writeJson(join(dir, "package.json"), mainPackageJson(template, root.version, binName));
  const files = listFiles(dir);
  if (JSON.stringify(files) !== JSON.stringify(PACKAGE_FILES)) {
    throw new Error(`the package holds ${files.join(", ")}; expected ${PACKAGE_FILES.join(", ")}`);
  }
  return dir;
}

function pack(out: string, dir: string): void {
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

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const root = readJson<IPackageJson>(join(ROOT, "package.json"));
  mkdirSync(options.out, { recursive: true });

  const define = buildInfoDefine({
    ...gitInfo(ROOT),
    built_at: buildDate(process.env, new Date()),
  });

  const dir = buildPackage(options.out, root, options.binName, define);
  const bundle = statSync(join(dir, "dist", "wip.mjs")).size;
  console.log(`${"npm/wip".padEnd(14)} ${(bundle / MB).toFixed(2)} MB bundle`);
  if (options.pack) pack(options.out, dir);

  if (options.targets.length > 0) {
    const archives: string[] = [];
    for (const target of options.targets) {
      const binary = buildBinary(target, options.out, define);
      archives.push(archiveBinary(binary, target, options.out, root.version));
      console.log(`${targetKey(target).padEnd(14)} ${(statSync(binary).size / MB).toFixed(1)} MB`);
    }
    writeFileSync(join(options.out, "release", "SHA256SUMS"), sha256sums(archives));
  }
}

if (import.meta.main) {
  main();
}
