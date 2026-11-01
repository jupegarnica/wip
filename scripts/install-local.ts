import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Builds the host tarballs and installs them with npm into a prefix of their own, as a user of the tarballs
// would, without the registry and without touching the global npm prefix:
//
//   bun run install:local                  # build into dist/, install into dist/local, run dist/local/bin/wip
//   bun run install:local --prefix <dir>   # install into <dir> instead
//   bun run install:local --out <dir>      # build into <dir> (and install into <dir>/local) instead

interface IOptions {
  prefix: string | null;
  out: string;
}

const ROOT = resolve(import.meta.dir, "..");
const WINDOWS = process.platform === "win32";
const HOST = `${WINDOWS ? "windows" : process.platform}-${process.arch}`;
const NPM = WINDOWS ? "npm.cmd" : "npm";
export const USAGE = "usage: bun scripts/install-local.ts [--prefix <dir>] [--out <dir>]";

export function parseArgs(argv: readonly string[]): IOptions {
  const options: IOptions = { prefix: null, out: join(ROOT, "dist") };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if ((arg === "--prefix" || arg === "--out") && value) {
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

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const out = options.out;
  const prefix = options.prefix ?? join(out, "local");
  const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    version: string;
  };

  process.stdout.write(
    exec(
      [
        process.execPath,
        join(ROOT, "scripts", "build.ts"),
        "--targets",
        "host",
        "--out",
        out,
        "--pack",
      ],
      ROOT,
    ),
  );

  // Absolute paths: npm reads `dist/x.tgz` (no leading ./ or /) as the GitHub repository `dist/x.tgz`.
  const tarballs = [
    join(out, `garndev-wip-${version}.tgz`),
    join(out, `garndev-wip-${HOST}-${version}.tgz`),
  ];
  for (const tarball of tarballs) {
    if (!existsSync(tarball)) throw new Error(`the build did not leave ${tarball}`);
  }
  exec(
    [
      NPM,
      "install",
      "-g",
      "--prefix",
      prefix,
      "--offline",
      "--no-audit",
      "--no-fund",
      "--no-update-notifier",
      ...tarballs,
    ],
    out,
  );

  const wip = WINDOWS ? join(prefix, "wip.cmd") : join(prefix, "bin", "wip");
  // `--version` never opens a project, so the working directory does not matter.
  const installed = exec([wip, "--version"], prefix).trim();
  console.log(`installed wip ${installed} for ${HOST} in ${prefix}`);
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
