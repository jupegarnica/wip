import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

// Installs this checkout as the command `wip2`, so it does not shadow a `wip` already on the PATH, without the
// registry and without touching the global npm prefix:
//
//   bun run install:local --node           # the npm package, as users get it: npm install -g of the packed tarball
//   bun run install:local                  # the standalone binary for this machine, copied to <prefix>/bin/wip2
//
// Both install into dist/local (run dist/local/bin/wip2) unless told otherwise:
//   --prefix <dir>   install into <dir> instead
//   --out <dir>      build into <dir> (and install into <dir>/local) instead

interface IOptions {
  prefix: string | null;
  out: string;
  node: boolean;
}

const ROOT = resolve(import.meta.dir, "..");
const WINDOWS = process.platform === "win32";
const HOST = `${WINDOWS ? "windows" : process.platform}-${process.arch}`;
export const BIN_NAME = "wip2";
const NPM = WINDOWS ? "npm.cmd" : "npm";
export const USAGE = "usage: bun scripts/install-local.ts [--node] [--prefix <dir>] [--out <dir>]";

export function parseArgs(argv: readonly string[]): IOptions {
  const options: IOptions = { prefix: null, out: join(ROOT, "dist"), node: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--node") {
      options.node = true;
    } else if ((arg === "--prefix" || arg === "--out") && value) {
      options[arg === "--prefix" ? "prefix" : "out"] = resolve(value);
      i++;
    } else {
      throw new Error(USAGE);
    }
  }
  return options;
}

function exec(cmd: string[], cwd: string): string {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "inherit" });
  if (result.exitCode !== 0)
    throw new Error(`command failed (${result.exitCode}): ${cmd.join(" ")}`);
  return result.stdout.toString();
}

function build(out: string, extra: string[]): void {
  const cmd = [process.execPath, join(ROOT, "scripts", "build.ts"), "--out", out, ...extra];
  process.stdout.write(exec(cmd, ROOT));
}

/** npm install -g of the packed tarball into `prefix`; returns the installed command. */
function installNode(out: string, prefix: string, version: string): string {
  build(out, ["--bin-name", BIN_NAME, "--pack"]);
  // Absolute path: npm reads `dist/x.tgz` (no leading ./ or /) as the GitHub repository `dist/x.tgz`.
  const tarball = join(out, `garndev-wip-${version}.tgz`);
  if (!existsSync(tarball)) throw new Error(`the build did not leave ${tarball}`);
  const flags = ["--offline", "--no-audit", "--no-fund", "--no-update-notifier"];
  exec([NPM, "install", "-g", "--prefix", prefix, ...flags, tarball], out);
  return WINDOWS ? join(prefix, `${BIN_NAME}.cmd`) : join(prefix, "bin", BIN_NAME);
}

/** The host binary copied to `<prefix>/bin/wip2`; returns it. */
function installBinary(out: string, prefix: string): string {
  build(out, ["--targets", "host"]);
  const built = join(out, "bin", HOST, WINDOWS ? "wip.exe" : "wip");
  if (!existsSync(built)) throw new Error(`the build did not leave ${built}`);
  const target = join(prefix, "bin", WINDOWS ? `${BIN_NAME}.exe` : BIN_NAME);
  mkdirSync(join(prefix, "bin"), { recursive: true });
  rmSync(target, { force: true });
  copyFileSync(built, target);
  chmodSync(target, 0o755);
  return target;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const out = options.out;
  const prefix = options.prefix ?? join(out, "local");
  const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    version: string;
  };
  const wip = options.node ? installNode(out, prefix, version) : installBinary(out, prefix);
  // `--version` never opens a project, so the working directory does not matter.
  const installed = exec([wip, "--version"], prefix).trim();
  const kind = options.node ? "the npm package (Node)" : `the ${HOST} binary`;
  console.log(`installed ${BIN_NAME} ${installed}, ${kind}, in ${prefix}`);
  console.log(`run: ${wip}`);
  console.log(
    "it migrates the database of every project it opens, and an older wip cannot read it afterwards:",
  );
  console.log("try it in a project made with `wip init` in an empty folder.");
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
