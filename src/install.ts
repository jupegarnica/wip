import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_INFO } from "./build-info.ts";
import type { TEnv } from "./env.ts";

/** How this process was shipped: `scripts/build.ts` defines it for the npm bundle and the binary. */
declare const WIP_INSTALL: string | undefined;

export type TInstallKind = "source" | "npm" | "binary";

export const PACKAGE_NAME = "@garndev/wip";
/** The file inside the package that `npm`'s `wip` shim runs. */
export const PACKAGE_BIN = "bin/wip.mjs";

/** Anything the build did not define (a source run) is `source`; an unknown value is treated the same. */
export function installKind(raw: unknown): TInstallKind {
  return raw === "npm" || raw === "binary" ? raw : "source";
}

export const INSTALL_KIND: TInstallKind = installKind(
  typeof WIP_INSTALL === "string" ? WIP_INSTALL : undefined,
);

export interface IPackageInfo {
  name: string;
  version: string;
  /** The package's `bin` object, commands only. */
  bin: Record<string, string>;
}

/** `<root>/package.json` when it is a JSON object of wip's package; null otherwise. */
export function packageInfo(root: string): IPackageInfo | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const fields = raw as Record<string, unknown>;
  if (fields.name !== PACKAGE_NAME) return null;
  const bin: Record<string, string> = {};
  if (typeof fields.bin === "object" && fields.bin !== null && !Array.isArray(fields.bin)) {
    for (const [name, file] of Object.entries(fields.bin)) {
      if (typeof file === "string") bin[name] = file;
    }
  }
  return {
    name: PACKAGE_NAME,
    version: typeof fields.version === "string" ? fields.version : "0.0.0",
    bin,
  };
}

function toPath(value: string): string {
  if (!value.startsWith("file:")) return resolve(value);
  try {
    return fileURLToPath(value);
  } catch {
    return value;
  }
}

export interface IPackageRootOptions {
  /** The bundle's `import.meta.url` by default. */
  file?: string;
  /** `WIP_LAUNCH_BIN`: the shim npm started. */
  launch?: string;
  /** `process.argv[1]`, when neither of the above resolves. */
  argv1?: string;
}

/**
 * The package root of an npm install: the folder two levels above the bundle (`dist/wip.mjs`) or the shim's target
 * (`bin/wip.mjs`), whose `package.json` names `@garndev/wip`. A source checkout has another package name, and an
 * `npm link` or a copy has none of those shapes.
 */
export function packageRoot(options: IPackageRootOptions = {}): string | null {
  const candidates = [options.file ?? import.meta.url, options.launch, options.argv1];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === "") continue;
    let path = toPath(candidate);
    try {
      path = realpathSync(path);
    } catch {
      // A path that does not exist can still have the package layout; the package.json check decides.
    }
    const root = dirname(dirname(path));
    if (seen.has(root)) continue;
    seen.add(root);
    if (packageInfo(root) !== null) return root;
  }
  return null;
}

/** `<prefix>/lib/node_modules/@garndev/wip` on POSIX, `<prefix>/node_modules/@garndev/wip` on Windows. */
const POSIX_SUFFIX = "/lib/node_modules/@garndev/wip";
const WINDOWS_SUFFIX = "/node_modules/@garndev/wip";

/** The npm prefix `root` lives under, or null when it is outside npm's global layout (a link or a copy). */
export function npmPrefixOf(root: string, platform: string = process.platform): string | null {
  const normalized = root.replaceAll("\\", "/").replace(/\/+$/, "");
  const suffix = platform === "win32" ? WINDOWS_SUFFIX : POSIX_SUFFIX;
  if (!normalized.endsWith(suffix)) return null;
  const prefix = normalized.slice(0, -suffix.length);
  if (prefix !== "") return prefix;
  return platform === "win32" ? null : "/";
}

/** The command npm's shim installs at the prefix: `<prefix>/bin/wip`, or `<prefix>/wip.cmd`. */
export function binPathOf(prefix: string, platform: string = process.platform): string {
  return join(prefix, ...(platform === "win32" ? ["wip.cmd"] : ["bin", "wip"]));
}

/** Whether the package root lives in Bun's global store, which npm does not use. */
export function isBunInstall(root: string, env: TEnv): boolean {
  const normalized = root.replaceAll("\\", "/");
  const store = (env.BUN_INSTALL ?? "").replaceAll("\\", "/").replace(/\/+$/, "");
  if (store !== "" && (normalized === store || normalized.startsWith(`${store}/`))) return true;
  return normalized.includes("/.bun/install/global/");
}

export function npmCommandFor(platform: string = process.platform): string {
  return platform === "win32" ? "npm.cmd" : "npm";
}

/**
 * One argument for `cmd.exe /c`: wrapped in double quotes when it holds whitespace or a command character. An
 * argument with a double quote is refused rather than misquoted.
 */
export function quoteWin(arg: string): string {
  if (arg.includes('"')) {
    throw new Error(`cannot pass an argument with a double quote to npm on Windows: ${arg}`);
  }
  return /[\s&|<>^]/.test(arg) ? `"${arg}"` : arg;
}

export interface IInstallInfo {
  kind: TInstallKind;
  /** The package root (npm) or the binary's path; null when unknown. */
  root: string | null;
  /** The npm prefix; null unless the install is npm's. */
  prefix: string | null;
  /** npm's shim at the prefix; null unless the install is npm's. */
  bin: string | null;
  /** The version of the running code. */
  version: string;
  /** Why `wip upgrade` may not install here; null when it may. */
  problem: string | null;
  /** The file inside the package that runs the CLI (`bin/wip.mjs`), for verification. */
  entry: string | null;
}

export interface IDetectOptions {
  kind?: TInstallKind;
  env?: TEnv;
  platform?: string;
  /** The bundle URL, for tests; `import.meta.url` by default. */
  file?: string;
  launch?: string;
  argv1?: string;
  version?: string;
}

const NOT_NPM =
  "wip is not installed by npm (an npm link, a copy outside node_modules, or a standalone binary): install it with `npm install -g @garndev/wip@latest`";

/** What this process is, where its package lives and whether npm can replace it. Reads the package, writes nothing. */
export function detectInstall(options: IDetectOptions = {}): IInstallInfo {
  const kind = options.kind ?? INSTALL_KIND;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const version = options.version ?? BUILD_INFO.version;
  const base: IInstallInfo = {
    kind,
    root: null,
    prefix: null,
    bin: null,
    version,
    problem: null,
    entry: null,
  };
  if (kind !== "npm") return base;

  const root = packageRoot({
    file: options.file,
    launch: options.launch ?? env.WIP_LAUNCH_BIN,
    argv1: options.argv1 ?? process.argv[1],
  });
  if (root === null) return { ...base, problem: NOT_NPM };

  if (isBunInstall(root, env)) {
    return {
      ...base,
      root,
      problem:
        "this is a Bun global install; npm would create a parallel layout Bun does not use: run `bun add -g @garndev/wip@latest`",
    };
  }

  const prefix = npmPrefixOf(root, platform);
  if (prefix === null) return { ...base, root, problem: NOT_NPM };

  const info = packageInfo(root);
  const bin = binPathOf(prefix, platform);
  const commands = info === null ? [] : Object.keys(info.bin).sort();
  const standard = commands.length === 1 && commands[0] === "wip" && info?.bin.wip === PACKAGE_BIN;
  if (!standard) {
    const name = commands[0] ?? "none";
    return {
      ...base,
      root,
      prefix,
      bin,
      problem: `this package provides the command ${commands.length === 0 ? "none" : `"${name}"`}, not "wip" (a --bin-name install); installing the registry package would remove it: reinstall this build from its tarball with --bin-name ${name}, or install @garndev/wip under "wip" and re-point wip_bin by hand (wip upgrade never writes wip_bin)`,
    };
  }

  return { kind, root, prefix, bin, version, problem: null, entry: PACKAGE_BIN };
}
