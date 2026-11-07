import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MIGRATIONS } from "../src/embedded/migrations.ts";
import { gitInfo, type IGitInfo } from "./build.ts";

// Installs this checkout as the npm package `@garndev/wip` into the global npm prefix under the command <name>,
// replacing the previous package in place so a path pinned in `wip_bin` stays valid:
//
//   bun run install:global --name wip2
//
// It never opens a project database and never runs a command that could migrate one: it prints the manual steps.
//   --name <name>   the command name (required)
//   --prefix <dir>  install into <dir> instead of the global npm prefix (`npm prefix -g`)
//   --out <dir>     build into <dir> (default dist)
//   --allow-dirty   install although the working tree has uncommitted changes (the version shows -dirty)
//   --replace       replace an installed @garndev/wip that provides another command name

export interface IGlobalOptions {
  name: string;
  prefix: string | null;
  out: string;
  allowDirty: boolean;
  replace: boolean;
}

interface IInstalledPackage {
  bin?: Record<string, string>;
}

const ROOT = resolve(import.meta.dir, "..");
const WINDOWS = process.platform === "win32";
const NPM = WINDOWS ? "npm.cmd" : "npm";
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
export const USAGE =
  "usage: bun scripts/install-global.ts --name <name> [--prefix <dir>] [--out <dir>] [--allow-dirty] [--replace]";

export function parseArgs(argv: readonly string[]): IGlobalOptions {
  const options: IGlobalOptions = {
    name: "",
    prefix: null,
    out: join(ROOT, "dist"),
    allowDirty: false,
    replace: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--allow-dirty") {
      options.allowDirty = true;
    } else if (arg === "--replace") {
      options.replace = true;
    } else if (arg === "--name" && value) {
      options.name = value;
      i++;
    } else if ((arg === "--prefix" || arg === "--out") && value) {
      options[arg === "--prefix" ? "prefix" : "out"] = resolve(value);
      i++;
    } else {
      throw new Error(USAGE);
    }
  }
  if (!NAME_PATTERN.test(options.name)) throw new Error(USAGE);
  return options;
}

/** The error text when the tree is dirty (or git is unusable) and that is not allowed; null otherwise. */
export function dirtyGate(info: IGitInfo, allowDirty: boolean): string | null {
  if (allowDirty || info.dirty === false) return null;
  const why =
    info.dirty === null ? "git is unusable here" : "the working tree has uncommitted changes";
  return `refusing a global install: ${why}. Commit or stash, or pass --allow-dirty.`;
}

/** The error text when the installed package provides another command and --replace is missing; null otherwise. */
export function replaceGate(
  installed: IInstalledPackage | null,
  name: string,
  replace: boolean,
): string | null {
  const bins = Object.keys(installed?.bin ?? {});
  if (bins.length === 0 || bins.includes(name) || replace) return null;
  return (
    `the prefix already holds @garndev/wip as ${bins.join(", ")}: installing ${name} would replace it and remove that command. ` +
    "Pass --replace to replace it, or --prefix <dir> to install side by side."
  );
}

/** A warning when the project's pinned `wip_bin` is not the command just installed; null otherwise. */
export function pinWarning(
  config: { wip_bin?: string } | null,
  installedBin: string,
): string | null {
  const pinned = config?.wip_bin;
  if (!pinned || pinned === installedBin) return null;
  return `warning: .wip/config.json pins wip_bin=${pinned}, not ${installedBin}; the pinned command is not the one just installed.`;
}

/** The manual steps for a project that already uses `name`; text only, nothing here runs them. */
export function nextSteps(name: string, schema: number): string {
  return [
    `this build uses database schema ${schema}; a project at an older schema is migrated by the first command that opens it.`,
    `next steps, by hand, for a project that already uses ${name}:`,
    "  1. stop `wip web` and the coordinator sessions of the project;",
    `  2. sqlite3 .wip/wip.sqlite ".backup '.wip/backups/db/wip-schema<N>-<date>.sqlite'"`,
    '     sqlite3 .wip/wip.sqlite "PRAGMA user_version"',
    `  3. ${name} check   (migrates and leaves .wip/backups/db/wip.sqlite.v<N>.*)`,
    "  4. restart `wip web` and the coordinator; other binaries that open the project exit 10 on it afterwards.",
  ].join("\n");
}

function exec(cmd: string[], cwd: string): string {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "inherit" });
  if (result.exitCode !== 0)
    throw new Error(`command failed (${result.exitCode}): ${cmd.join(" ")}`);
  return result.stdout.toString();
}

function readJson<T>(path: string): T | null {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
  } catch {
    return null;
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const dirty = dirtyGate(gitInfo(ROOT), options.allowDirty);
  if (dirty) {
    const status = Bun.spawnSync(["git", "-C", ROOT, "status", "--short"], { stdout: "pipe" });
    throw new Error(`${dirty}\n${status.stdout.toString().trimEnd()}`);
  }
  if (options.allowDirty && gitInfo(ROOT).dirty !== false)
    console.warn("warning: dirty tree; --version will show -dirty.");

  const prefix = options.prefix ?? exec([NPM, "prefix", "-g"], ROOT).trim();
  const out = options.out;
  const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    version: string;
  };
  process.stdout.write(
    exec(
      [
        process.execPath,
        join(ROOT, "scripts", "build.ts"),
        "--out",
        out,
        "--bin-name",
        options.name,
        "--pack",
      ],
      ROOT,
    ),
  );

  const modules = WINDOWS ? join(prefix, "node_modules") : join(prefix, "lib", "node_modules");
  const installed = readJson<IInstalledPackage>(join(modules, "@garndev", "wip", "package.json"));
  const refusal = replaceGate(installed, options.name, options.replace);
  if (refusal) throw new Error(refusal);

  // Absolute path: npm reads `dist/x.tgz` (no leading ./ or /) as the GitHub repository `dist/x.tgz`.
  const tarball = join(out, `garndev-wip-${version}.tgz`);
  if (!existsSync(tarball)) throw new Error(`the build did not leave ${tarball}`);
  const flags = ["--offline", "--no-audit", "--no-fund", "--no-update-notifier"];
  exec([NPM, "install", "-g", "--prefix", prefix, ...flags, tarball], out);

  const bin = WINDOWS ? join(prefix, `${options.name}.cmd`) : join(prefix, "bin", options.name);
  // `--version` opens no project; the working directory is the prefix.
  let reported: string;
  try {
    reported = exec([bin, "--version"], prefix).trim();
  } catch {
    throw new Error(
      `installed in ${prefix} but \`${bin} --version\` failed (Node ${process.versions.node}; the package needs Node 22.13+)`,
    );
  }
  console.log(`installed ${options.name} ${reported} in ${prefix}`);
  console.log(`command: ${bin}`);
  const pin = pinWarning(
    readJson<{ wip_bin?: string }>(join(process.cwd(), ".wip", "config.json")),
    bin,
  );
  if (pin) console.warn(pin);
  console.log(nextSteps(options.name, MIGRATIONS.length));
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
