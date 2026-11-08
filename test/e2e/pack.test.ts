import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { KANBAN_MOD } from "../../src/embedded/kanban.ts";
import { EXIT } from "../../src/errors.ts";
import { scratch } from "../helpers/project.ts";

// Opt-in: `WIP_PACK_DIR=<dir>` builds there (unless already built) the npm package tarball and the host binary, installs
// the tarball with npm into a prefix inside it and runs both. It never touches the global npm prefix and needs no
// registry: the package has no dependencies.

const PACK_DIR = process.env.WIP_PACK_DIR ?? null;
const REPO = join(import.meta.dir, "..", "..");
const VERSION = (
  JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version: string }
).version;
const WINDOWS = process.platform === "win32";
const HOST = `${WINDOWS ? "windows" : process.platform}-${process.arch}`;
const NPM = WINDOWS ? "npm.cmd" : "npm";
const NO_NODE_PATH = WINDOWS ? "C:\\Windows\\System32" : "/usr/bin:/bin";

const ID = "wip-kanban@skills-dir";

/** The installed copy, keyed by its path under `.claude/skills/wip-kanban/`. */
function modFiles(project: string): Record<string, string> {
  const dir = join(project, ".claude", "skills", "wip-kanban");
  return Object.fromEntries(
    Object.keys(KANBAN_MOD)
      .sort()
      .map((key) => [key, readFileSync(join(dir, key), "utf8")]),
  );
}

const VERSION_LINE = new RegExp(
  `^${VERSION.replaceAll(".", "\\.")} \\(.+, built \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ\\)\n$`,
);
const tarball = (dir: string): string => join(dir, `garndev-wip-${VERSION}.tgz`);
const hostBinary = (dir: string): string => join(dir, "bin", HOST, WINDOWS ? "wip.exe" : "wip");

/** `<prefix>/bin/wip` on Unix; npm puts the shim at the prefix root on Windows. */
const installedWip = (prefix: string): string =>
  WINDOWS ? join(prefix, "wip.cmd") : join(prefix, "bin", "wip");

function exec(cmd: string[], cwd: string, env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env } });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe.skipIf(PACK_DIR === null)("the npm package and the binary (set WIP_PACK_DIR)", () => {
  const dir = PACK_DIR ?? "";
  const prefix = join(dir, "npm-prefix");

  beforeAll(() => {
    if (!existsSync(tarball(dir)) || !existsSync(hostBinary(dir))) {
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
    rmSync(prefix, { recursive: true, force: true });
    // cwd is `dir`: pass `./name.tgz`, the form the README gives. npm reads `dir/name.tgz` (no leading ./) as the
    // GitHub repository `dir/name.tgz`.
    const install = exec(
      [
        NPM,
        "install",
        "-g",
        "--prefix",
        prefix,
        "--offline",
        "--no-audit",
        "--no-fund",
        `./${basename(tarball(dir))}`,
      ],
      dir,
    );
    if (install.code !== 0)
      throw new Error(`npm install failed (${install.code}): ${install.stderr}`);
  }, 180000);

  test("the tarball holds only the bin, the bundle, README, LICENSE and package.json", () => {
    const listing = exec(["tar", "-tzf", tarball(dir)], dir)
      .stdout.trim()
      .split("\n")
      .sort();
    expect(listing).toEqual([
      "package/LICENSE",
      "package/README.md",
      "package/bin/wip.mjs",
      "package/dist/wip.mjs",
      "package/package.json",
    ]);
  });

  test("the installed wip runs on Node: version, help, init, check and state, with no SQLite warning", () => {
    const wip = installedWip(prefix);
    const version = exec([wip, "--version"], dir);
    expect(version.code).toBe(EXIT.OK);
    expect(version.stdout).toMatch(VERSION_LINE);
    expect(version.stderr).toBe("");
    const help = exec([wip, "help"], dir);
    expect(help.code).toBe(EXIT.OK);
    expect(help.stdout).toContain("web");
    const project = scratch("pack-node");
    try {
      exec(["git", "init", "-q"], project);
      const init = exec([wip, "init", "--yes"], project);
      expect(init.code).toBe(EXIT.OK);
      expect(init.stderr).not.toContain("ExperimentalWarning");
      expect(exec([wip, "check"], project).code).toBe(EXIT.OK);
      const state = exec([wip, "state", "--json"], project);
      expect(state.code).toBe(EXIT.OK);
      expect((JSON.parse(state.stdout) as { ok: boolean }).ok).toBe(true);
      expect(state.stderr).toBe("");
    } finally {
      rmSync(realpathSync(project), { recursive: true, force: true });
    }
  });

  test("the binary runs on its own with neither Node nor Bun in PATH", () => {
    const binary = hostBinary(dir);
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
      // The templates carry their model line, so nothing is unset after init.
      expect(body.warnings.find((w) => w.code === "models_unset")).toBeUndefined();
    } finally {
      rmSync(realpathSync(project), { recursive: true, force: true });
    }
  });

  test("the release archive and SHA256SUMS of the host binary", () => {
    const ext = WINDOWS ? "zip" : "tar.gz";
    const archive = join(dir, "release", `wip-${VERSION}-${HOST}.${ext}`);
    expect(existsSync(archive)).toBe(true);
    expect(readFileSync(join(dir, "release", "SHA256SUMS"), "utf8")).toContain(basename(archive));
  });

  test("init --kanban installs the same copy and entry from the npm package, with no network", () => {
    const wip = installedWip(prefix);
    const project = scratch("pack-kanban");
    try {
      const out = exec([wip, "init", "--yes", "--kanban"], project);
      expect(out.code).toBe(EXIT.OK);
      expect(modFiles(project)).toEqual(
        Object.fromEntries(
          Object.keys(KANBAN_MOD)
            .sort()
            .map((key) => [key, KANBAN_MOD[key] as string]),
        ),
      );
      const settings = JSON.parse(
        readFileSync(join(project, ".claude", "settings.json"), "utf8"),
      ) as { enabledPlugins: Record<string, boolean> };
      expect(settings.enabledPlugins[ID]).toBe(true);
      expect(existsSync(join(project, ".claude", "settings.local.json"))).toBe(false);
    } finally {
      rmSync(realpathSync(project), { recursive: true, force: true });
    }
  });

  test("init --kanban with settings.local.json writes only the personal file", () => {
    const wip = installedWip(prefix);
    const project = scratch("pack-kanban-local");
    try {
      const out = exec(
        [wip, "init", "--yes", "--kanban", "--kanban-settings-file", "settings.local.json"],
        project,
      );
      expect(out.code).toBe(EXIT.OK);
      expect(existsSync(join(project, ".claude", "settings.json"))).toBe(false);
      const settings = JSON.parse(
        readFileSync(join(project, ".claude", "settings.local.json"), "utf8"),
      ) as { enabledPlugins: Record<string, boolean> };
      expect(settings.enabledPlugins[ID]).toBe(true);
    } finally {
      rmSync(realpathSync(project), { recursive: true, force: true });
    }
  });

  test("the standalone binary installs the same copy with neither Node nor Bun in PATH", () => {
    const binary = hostBinary(dir);
    const project = scratch("pack-kanban-bin");
    try {
      const env = { PATH: NO_NODE_PATH };
      const out = exec([binary, "init", "--yes", "--kanban"], project, env);
      expect(out.code).toBe(EXIT.OK);
      expect(modFiles(project)).toEqual(
        Object.fromEntries(
          Object.keys(KANBAN_MOD)
            .sort()
            .map((key) => [key, KANBAN_MOD[key] as string]),
        ),
      );
      const settings = JSON.parse(
        readFileSync(join(project, ".claude", "settings.json"), "utf8"),
      ) as { enabledPlugins: Record<string, boolean> };
      expect(settings.enabledPlugins[ID]).toBe(true);
    } finally {
      rmSync(realpathSync(project), { recursive: true, force: true });
    }
  });
});
