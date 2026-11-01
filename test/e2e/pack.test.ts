import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
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

const VERSION_LINE = new RegExp(
  `^${VERSION.replaceAll(".", "\\.")} \\(.+, built \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ\\)\n$`,
);
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
  // cwd is `dir`: pass `./name.tgz`, the form the README gives. npm reads `dir/name.tgz` (no leading ./)
  // as the GitHub repository `dir/name.tgz`.
  const relative = tarballs.map((tarball) => `./${basename(tarball)}`);
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
      ...relative,
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
    const version = exec([wip, "--version"], dir);
    expect(version.code).toBe(EXIT.OK);
    expect(version.stdout).toMatch(VERSION_LINE);
    const help = exec([wip, "help"], dir);
    expect(help.code).toBe(EXIT.OK);
    expect(help.stdout).toContain("init");
    expect(help.stdout).toContain("web");
    expect(existsSync(hostBinary(full))).toBe(true);
  });

  test("with --omit=optional the platform tarball installed alongside still resolves", () => {
    const version = exec([installedWip(omit), "--version"], dir);
    expect(version.code).toBe(EXIT.OK);
    expect(version.stdout).toMatch(VERSION_LINE);
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
      const version = exec([binary, "--version"], project, env);
      expect(version.code).toBe(EXIT.OK);
      expect(version.stdout).toMatch(VERSION_LINE);
      const info = JSON.parse(exec([binary, "version", "--json"], project, env).stdout) as {
        data: { source: boolean; built_at: unknown };
      };
      expect(info.data.source).toBe(false);
      expect(typeof info.data.built_at).toBe("string");
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
