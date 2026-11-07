import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLaunch } from "../../src/commands/start.ts";
import { configPath } from "../../src/config.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "main.ts");
const BIN = join(import.meta.dir, "..", "..", "npm", "wip", "bin", "wip.mjs");
let base: string;
let dir: string;
let bin: string;
let home: string;
let log: string;

/**
 * A fake `claude` on PATH that records its argv, cwd, WIP_START, WIP_BIN (`<unset>` when absent), the WIP_BIN of a
 * grandchild `sh` (a normal child spawn, as the runtime's Bash tool makes one) and WIP_LAUNCH_BIN, then exits with FAKE_EXIT.
 */
const FAKE = `#!/bin/sh
{ printf 'argv:'; for a in "$@"; do printf ' [%s]' "$a"; done; echo; echo "cwd=$(pwd)"; echo "WIP_START=$WIP_START"; echo "WIP_BIN=\${WIP_BIN-<unset>}"; echo "GRANDCHILD_WIP_BIN=$(sh -c 'printf %s "\${WIP_BIN-<unset>}"')"; echo "WIP_LAUNCH_BIN=$WIP_LAUNCH_BIN"; } > "$FAKE_LOG"
exit \${FAKE_EXIT:-0}
`;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "wip-start-e2e-"));
  dir = join(base, "project");
  bin = join(base, "bin");
  home = join(base, "home");
  log = join(base, "log.txt");
  mkdirSync(dir);
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(join(bin, "claude"), FAKE);
  chmodSync(join(bin, "claude"), 0o755);
  const init = Bun.spawnSync([process.execPath, CLI, "init"], {
    cwd: dir,
    env: { PATH: "/usr/bin:/bin", HOME: home },
  });
  expect(init.exitCode).toBe(0);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** The real CLI in a child process, with no inherited WIP variables. */
function cli(argv: string[], extra: Record<string, string> = {}) {
  const proc = Bun.spawnSync([process.execPath, CLI, ...argv], {
    cwd: dir,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...extra },
    stdin: "ignore",
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

const env = (extra: Record<string, string> = {}) => ({
  PATH: `${bin}:/usr/bin:/bin`,
  HOME: home,
  FAKE_LOG: log,
  ...extra,
});

describe("wip start", () => {
  test("--dry-run --json expands the default without saving it", () => {
    const out = cli(["start", "--dry-run", "--json"]);
    expect(out.code).toBe(0);
    const argv = JSON.parse(out.stdout).data.argv as string[];
    expect(argv.slice(0, 4)).toEqual(["claude", "--agent", "wip", "--name"]);
    expect(argv[4]).toMatch(/^wip-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/);
    expect(readFileSync(configPath(dir), "utf8")).not.toContain('"start"');
  });

  test("without a terminal, explicit start exits 2 and runs nothing; bare wip prints the help", () => {
    const explicit = cli(["start"], env());
    expect(explicit.code).toBe(2);
    expect(explicit.stderr).toContain("needs a terminal");
    expect(existsSync(log)).toBe(false);
    const bare = cli([]);
    expect(bare.code).toBe(0);
    expect(bare.stdout).toContain("wip");
    expect(existsSync(log)).toBe(false);
  });

  test("inside a session wip started (WIP_START set), start exits 2", () => {
    const out = cli(["start"], { WIP_START: "26-01-01-00-00" });
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("WIP_START");
  });

  test("--set is kept by init --force", () => {
    expect(cli(["start", "--set", "--", "fake-tool", "{project}"]).code).toBe(0);
    expect(cli(["init", "--force"]).code).toBe(0);
    expect(JSON.parse(readFileSync(configPath(dir), "utf8")).start).toEqual([
      "fake-tool",
      "{project}",
    ]);
  });

  test("--set rejects an unknown variable and changes nothing", () => {
    const before = readFileSync(configPath(dir), "utf8");
    expect(cli(["start", "--set", "--", "x-{nope}"]).code).toBe(2);
    expect(readFileSync(configPath(dir), "utf8")).toBe(before);
  });
});

describe("the launch", () => {
  test("runs the command from the project root with WIP_START, and returns its exit code", async () => {
    const code = await startLaunch([], dir, env({ FAKE_EXIT: "7" }), true);
    expect(code).toBe(7);
    const text = readFileSync(log, "utf8");
    expect(text).toMatch(/argv: \[--agent\] \[wip\]/);
    expect(text).toMatch(/\[--name\] \[wip-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\]/);
    expect(text).toContain(`cwd=${realpathSync(dir)}`);
    expect(text).toMatch(/WIP_START=\d{2}-\d{2}-\d{2}-\d{2}-\d{2}/);
  });

  test("extra arguments after -- go last", async () => {
    expect(await startLaunch(["--", "--resume"], dir, env(), true)).toBe(0);
    expect(readFileSync(log, "utf8")).toMatch(/\[wip-\d{2}-[^\]]+\] \[--resume\]/);
  });

  test("a missing executable exits 127", async () => {
    expect(cli(["start", "--set", "--", "no-such-tool-zz"]).code).toBe(0);
    expect(await startLaunch([], dir, env(), true)).toBe(127);
  });

  test("refusals exit 2 before running anything", async () => {
    expect(await startLaunch([], dir, env({ WIP_START: "x" }), true)).toBe(2);
    expect(await startLaunch([], dir, env(), false)).toBe(2);
    expect(await startLaunch(["--bogus"], dir, env(), true)).toBe(2);
    expect(existsSync(log)).toBe(false);
  });
});

describe("the launcher path (wip_bin)", () => {
  /** Runs `startLaunch` and returns what it wrote on stderr. */
  async function launchWith(extra: Record<string, string>): Promise<{ code: number; err: string }> {
    const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await startLaunch([], dir, env(extra), true);
      const err = spy.mock.calls.map((c) => String(c[0])).join("");
      return { code, err };
    } finally {
      spy.mockRestore();
    }
  }

  const wipBin = () => JSON.parse(readFileSync(configPath(dir), "utf8")).wip_bin;

  test("a launch records WIP_LAUNCH_BIN as wip_bin, says so once, and keeps the child env clean", async () => {
    const first = await launchWith({ WIP_LAUNCH_BIN: "/x/bin/wip2" });
    expect(first.code).toBe(0);
    expect(wipBin()).toBe("/x/bin/wip2");
    expect(first.err).toBe("🟨 wip_bin set to /x/bin/wip2 in .wip/config.json\n");
    expect(readFileSync(log, "utf8")).toMatch(/WIP_LAUNCH_BIN=\n$/);
    expect(JSON.parse(readFileSync(configPath(dir), "utf8")).start).toBeUndefined();
  });

  test("the same value again is silent and leaves the file untouched", async () => {
    await launchWith({ WIP_LAUNCH_BIN: "/x/bin/wip2" });
    const before = readFileSync(configPath(dir), "utf8");
    const again = await launchWith({ WIP_LAUNCH_BIN: "/x/bin/wip2" });
    expect(again.err).toBe("");
    expect(readFileSync(configPath(dir), "utf8")).toBe(before);
  });

  test("a different value overwrites it with a changed line", async () => {
    await launchWith({ WIP_LAUNCH_BIN: "/x/bin/wip2" });
    const other = await launchWith({ WIP_LAUNCH_BIN: "/y/bin/wip2" });
    expect(other.err).toBe(
      "🟨 wip_bin changed from /x/bin/wip2 to /y/bin/wip2 in .wip/config.json\n",
    );
    expect(wipBin()).toBe("/y/bin/wip2");
  });

  test("a dev run (bun, no launcher) records nothing", async () => {
    const out = await launchWith({});
    expect(out.code).toBe(0);
    expect(out.err).toBe("");
    expect(wipBin()).toBeUndefined();
  });

  test("--dry-run, --show, --set and --unset never record it", () => {
    const e = { WIP_LAUNCH_BIN: "/z/wip2" };
    expect(cli(["start", "--dry-run"], e).code).toBe(0);
    expect(cli(["start", "--show"], e).code).toBe(0);
    expect(cli(["start", "--set", "--", "fake-tool"], e).code).toBe(0);
    expect(cli(["start", "--unset"], e).code).toBe(0);
    expect(wipBin()).toBeUndefined();
  });

  test("a refused launch (WIP_START set) records nothing", async () => {
    expect(await launchWith({ WIP_LAUNCH_BIN: "/x/bin/wip2", WIP_START: "x" })).toMatchObject({
      code: 2,
    });
    expect(wipBin()).toBeUndefined();
  });

  // The bin runs under node, as the published package does: bun resolves the symlink of the main module, node does not.
  test.skipIf(!Bun.which("node"))(
    "the npm bin gives the CLI the path it was started as, through a symlink",
    () => {
      const seen = join(base, "seen.txt");
      const pkg = join(base, "pkg");
      mkdirSync(join(pkg, "bin"), { recursive: true });
      mkdirSync(join(pkg, "dist"));
      copyFileSync(BIN, join(pkg, "bin", "wip.mjs"));
      writeFileSync(
        join(pkg, "dist", "wip.mjs"),
        `import { writeFileSync } from "node:fs";\nexport async function main() {\n  writeFileSync(${JSON.stringify(seen)}, process.env.WIP_LAUNCH_BIN ?? "");\n  return 0;\n}\n`,
      );
      const link = join(base, "wip2");
      symlinkSync(join(pkg, "bin", "wip.mjs"), link);
      const nodeEnv = { PATH: "/usr/bin:/bin", HOME: home };
      expect(Bun.spawnSync([Bun.which("node") as string, link], { env: nodeEnv }).exitCode).toBe(0);
      expect(readFileSync(seen, "utf8")).toBe(link);
      // A value already set by an outer launcher is kept.
      Bun.spawnSync([Bun.which("node") as string, link], {
        env: { ...nodeEnv, WIP_LAUNCH_BIN: "/keep/wip" },
      });
      expect(readFileSync(seen, "utf8")).toBe("/keep/wip");
    },
  );
});

describe("the session environment (WIP_BIN)", () => {
  /** Runs `startLaunch` with `extra` in the env and returns the fake's record of the session. */
  async function session(extra: Record<string, string>): Promise<string> {
    const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await startLaunch([], dir, env(extra), true)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    return readFileSync(log, "utf8");
  }
  const bin = (text: string, key = "WIP_BIN") => text.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1];

  test("a launch exports the recorded path to the session and to its grandchild", async () => {
    const text = await session({ WIP_LAUNCH_BIN: "/x/bin/wip2" });
    expect(bin(text)).toBe("/x/bin/wip2");
    expect(bin(text, "GRANDCHILD_WIP_BIN")).toBe("/x/bin/wip2");
    expect(bin(text, "WIP_LAUNCH_BIN")).toBe("");
  });

  test("a second launch with another path exports the new value", async () => {
    await session({ WIP_LAUNCH_BIN: "/x/bin/wip2" });
    const text = await session({ WIP_LAUNCH_BIN: "/y/bin/wip2" });
    expect(bin(text)).toBe("/y/bin/wip2");
  });

  test("a dev run with a stored wip_bin exports the stored value", async () => {
    await session({ WIP_LAUNCH_BIN: "/x/bin/wip2" });
    expect(bin(await session({}))).toBe("/x/bin/wip2");
  });

  test("a dev run with no stored value leaves WIP_BIN unset in the session", async () => {
    expect(bin(await session({}))).toBe("<unset>");
  });

  test("a stale WIP_BIN from the user's shell never reaches the session", async () => {
    const text = await session({ WIP_BIN: "/stale/wip" });
    expect(bin(text)).toBe("<unset>");
    expect(bin(text, "GRANDCHILD_WIP_BIN")).toBe("<unset>");
  });

  test("a stored wip_bin wins over a WIP_BIN in the environment of wip start", async () => {
    await session({ WIP_LAUNCH_BIN: "/x/bin/wip2" });
    expect(bin(await session({ WIP_BIN: "/stale/wip" }))).toBe("/x/bin/wip2");
  });

  test("a stored relative wip_bin reaches the session absolute, against the project root", async () => {
    const cfg = JSON.parse(readFileSync(configPath(dir), "utf8"));
    cfg.wip_bin = "bin/wip";
    writeFileSync(configPath(dir), JSON.stringify(cfg));
    const text = await session({});
    expect(bin(text)).toBe(join(dir, "bin", "wip"));
  });
});
