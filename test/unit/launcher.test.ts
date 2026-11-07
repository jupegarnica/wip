import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch } from "../helpers/project.ts";

// npm/wip/bin/wip.mjs, the `wip` command of the npm package: it runs on Node, checks its version, hides the SQLite
// ExperimentalWarning and imports ../dist/wip.mjs. The process tests give it a stand-in bundle.

interface ILauncher {
  MIN_NODE: string;
  nodeTooOld: (version: string) => boolean;
  isSqliteWarning: (warning: unknown) => boolean;
  filterSqliteWarning: (proc: { emitWarning: (...args: unknown[]) => void }) => void;
  launchBin: (
    env: Record<string, string | undefined>,
    argv: string[],
    platform: string,
  ) => string | null;
}

const LAUNCHER = join(import.meta.dir, "..", "..", "npm", "wip", "bin", "wip.mjs");
const launcher = (await import(LAUNCHER)) as ILauncher;
const NODE = Bun.which("node");

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("the bin's helpers", () => {
  test("Node 22.13 is the floor", () => {
    expect(launcher.MIN_NODE).toBe("22.13.0");
    for (const old of ["20.19.0", "22.12.9", "v22.5.0", "18.0.0"]) {
      expect(launcher.nodeTooOld(old)).toBe(true);
    }
    for (const ok of ["22.13.0", "v22.16.0", "24.15.0", "26.13.0", "30.0.0"]) {
      expect(launcher.nodeTooOld(ok)).toBe(false);
    }
  });

  test("only the SQLite experimental warning is dropped", () => {
    const seen: unknown[] = [];
    const proc = { emitWarning: (...args: unknown[]) => void seen.push(args[0]) };
    launcher.filterSqliteWarning(proc);
    proc.emitWarning(
      "SQLite is an experimental feature and might change at any time",
      "ExperimentalWarning",
    );
    proc.emitWarning(new Error("SQLite is an experimental feature and might change at any time"));
    proc.emitWarning("something else", "DeprecationWarning");
    expect(seen).toEqual(["something else"]);
  });

  test("WIP_LAUNCH_BIN is the path it was started as, never on Windows, never over a value already set", () => {
    const argv = ["/usr/bin/node", "/p/bin/wip2"];
    expect(launcher.launchBin({}, argv, "darwin")).toBe("/p/bin/wip2");
    expect(launcher.launchBin({}, argv, "linux")).toBe("/p/bin/wip2");
    expect(launcher.launchBin({}, argv, "win32")).toBeNull();
    expect(launcher.launchBin({ WIP_LAUNCH_BIN: "/x/wip" }, argv, "darwin")).toBeNull();
    expect(launcher.launchBin({}, ["/usr/bin/node"], "darwin")).toBeNull();
  });
});

/** A package folder with the real bin and a stand-in bundle that loads node:sqlite and reports what it got. */
function fakePackage(): string {
  const dir = scratch("launcher");
  dirs.push(dir);
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "dist"));
  copyFileSync(LAUNCHER, join(dir, "bin", "wip.mjs"));
  writeFileSync(
    join(dir, "dist", "wip.mjs"),
    `import { DatabaseSync } from "node:sqlite";
export async function main(argv) {
  new DatabaseSync(":memory:").close();
  process.emitWarning("another warning");
  await new Promise((resolve) => setTimeout(resolve, 20)); // warnings print on a later tick
  console.log(JSON.stringify({ argv, launch: process.env.WIP_LAUNCH_BIN ?? null }));
  return 7;
}
`,
  );
  return dir;
}

describe.skipIf(NODE === null || process.platform === "win32")(
  "the bin as a process on Node",
  () => {
    const node = NODE as string;

    test("runs main with the arguments, exits with its code, hides only the SQLite warning", () => {
      const dir = fakePackage();
      const link = join(dir, "wip2");
      symlinkSync(join(dir, "bin", "wip.mjs"), link);
      const env = { ...process.env, WIP_LAUNCH_BIN: undefined };
      const result = Bun.spawnSync([node, link, "state", "--json"], { env });
      expect(result.exitCode).toBe(7);
      expect(JSON.parse(result.stdout.toString())).toEqual({
        argv: ["state", "--json"],
        launch: link,
      });
      const stderr = result.stderr.toString();
      expect(stderr).not.toContain("SQLite is an experimental feature");
      expect(stderr).toContain("another warning");
    });

    test("a value of WIP_LAUNCH_BIN already set is kept", () => {
      const dir = fakePackage();
      const result = Bun.spawnSync([node, join(dir, "bin", "wip.mjs")], {
        env: { ...process.env, WIP_LAUNCH_BIN: "/kept/wip" },
      });
      expect(JSON.parse(result.stdout.toString()).launch).toBe("/kept/wip");
    });

    test("an older Node exits 2 with the version it needs, before loading the bundle", () => {
      const dir = fakePackage();
      const fake =
        'data:text/javascript,Object.defineProperty(process,"versions",{value:{...process.versions,node:"20.19.0"}})';
      const result = Bun.spawnSync([
        node,
        "--import",
        fake,
        join(dir, "bin", "wip.mjs"),
        "--version",
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toContain("wip needs Node 22.13.0 or later (found 20.19.0)");
    });
  },
);
