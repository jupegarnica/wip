import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EXIT } from "../../src/errors.ts";
import { scratch } from "../helpers/project.ts";

// Opt-in: `WIP_PACK_DIR=<dir>` builds the host tarballs there (unless they already exist) and installs them
// with npm into prefixes inside it. It never touches the global npm prefix and needs no registry.

const PACK_DIR = process.env.WIP_PACK_DIR ?? null;
const REPO = join(import.meta.dir, "..", "..");
const VERSION = (
  JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version: string }
).version;
const WINDOWS = process.platform === "win32";
const HOST = `${WINDOWS ? "windows" : process.platform}-${process.arch}`;
const NPM = WINDOWS ? "npm.cmd" : "npm";
const NO_NODE_PATH = WINDOWS ? "C:\\Windows\\System32" : "/usr/bin:/bin";

const mainTgz = (dir: string): string => join(dir, `garndev-wip-${VERSION}.tgz`);
const hostTgz = (dir: string): string => join(dir, `garndev-wip-${HOST}-${VERSION}.tgz`);

/** `<prefix>/bin/wip` on Unix; npm puts the shim at the prefix root on Windows. */
const installedWip = (prefix: string): string =>
  WINDOWS ? join(prefix, "wip.cmd") : join(prefix, "bin", "wip");

const installedModules = (prefix: string): string =>
  WINDOWS ? join(prefix, "node_modules") : join(prefix, "lib", "node_modules");

const hostBinary = (prefix: string): string =>
  join(installedModules(prefix), "@garndev", `wip-${HOST}`, "bin", WINDOWS ? "wip.exe" : "wip");

function exec(cmd: string[], cwd: string, env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env } });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function npmInstall(dir: string, prefix: string, tarballs: string[], flags: string[] = []): void {
  rmSync(prefix, { recursive: true, force: true });
  const out = exec(
    [
      NPM,
      "install",
      "-g",
      "--prefix",
      prefix,
      "--offline",
      "--no-audit",
      "--no-fund",
      ...flags,
      ...tarballs,
    ],
    dir,
  );
  if (out.code !== 0) throw new Error(`npm install failed (${out.code}): ${out.stderr}`);
}

describe.skipIf(PACK_DIR === null)("tarballs installed with npm (§1.1, set WIP_PACK_DIR)", () => {
  const dir = PACK_DIR ?? "";
  const full = join(dir, "npm-prefix");
  const omit = join(dir, "npm-prefix-omit");
  const mainOnly = join(dir, "npm-prefix-main");

  beforeAll(() => {
    if (!existsSync(mainTgz(dir)) || !existsSync(hostTgz(dir))) {
      const build = exec(
        [
          process.execPath,
          join(REPO, "scripts", "build.ts"),
          "--targets",
          "host",
          "--out",
          dir,
          "--pack",
        ],
        REPO,
      );
      if (build.code !== 0) throw new Error(`build failed: ${build.stderr}`);
    }
    npmInstall(dir, full, [mainTgz(dir), hostTgz(dir)]);
    npmInstall(dir, omit, [mainTgz(dir), hostTgz(dir)], ["--omit=optional"]);
    npmInstall(dir, mainOnly, [mainTgz(dir)]);
  }, 180000);

  test("the build left the main and the host tarballs", () => {
    expect(existsSync(mainTgz(dir))).toBe(true);
    expect(existsSync(hostTgz(dir))).toBe(true);
  });

  test("without --omit=optional and with no registry, the installed wip answers through the launcher", () => {
    const wip = installedWip(full);
    expect(exec([wip, "--version"], dir)).toMatchObject({ code: EXIT.OK, stdout: `${VERSION}\n` });
    const help = exec([wip, "help"], dir);
    expect(help.code).toBe(EXIT.OK);
    expect(help.stdout).toContain("init");
    expect(help.stdout).toContain("web");
    expect(existsSync(hostBinary(full))).toBe(true);
  });

  test("with --omit=optional the platform tarball installed alongside still resolves", () => {
    expect(exec([installedWip(omit), "--version"], dir)).toMatchObject({
      code: EXIT.OK,
      stdout: `${VERSION}\n`,
    });
  });

  test("without the platform package the launcher exits 2 and names --omit=optional", () => {
    const out = exec([installedWip(mainOnly), "--version"], dir);
    expect(out.code).toBe(EXIT.USAGE);
    expect(out.stderr).toContain(`@garndev/wip-${HOST}`);
    expect(out.stderr).toContain("--omit=optional");
  });

  test("the platform binary runs on its own with neither Node nor Bun in PATH", () => {
    const binary = hostBinary(full);
    const project = scratch("pack-no-node");
    try {
      const env = { PATH: NO_NODE_PATH };
      expect(exec([binary, "--version"], project, env)).toMatchObject({
        code: EXIT.OK,
        stdout: `${VERSION}\n`,
      });
      expect(exec([binary, "init"], project, env).code).toBe(EXIT.OK);
      expect(exec([binary, "flow", "lint"], project, env).code).toBe(EXIT.OK);
      const check = exec([binary, "check", "--json"], project, env);
      expect(check.code).toBe(EXIT.OK);
      const body = JSON.parse(check.stdout) as { warnings: { code: string; agents?: string[] }[] };
      expect(body.warnings.find((w) => w.code === "models_unset")?.agents).toEqual([
        "efficient",
        "fast",
        "thinker",
        "wip",
        "wise",
      ]);
    } finally {
      rmSync(realpathSync(project), { recursive: true, force: true });
    }
  });
});
