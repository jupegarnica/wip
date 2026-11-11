import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  archiveName,
  buildDate,
  buildInfoDefine,
  gitInfo,
  installDefine,
  listFiles,
  mainPackageJson,
  PACKAGE_FILES,
  sha256sums,
} from "../../scripts/build.ts";
import { scratch } from "../helpers/project.ts";

const HAS_GIT = Bun.which("git") !== null;
const REPO = join(import.meta.dir, "..", "..");
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(
    ["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { env: ENV, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.toString().trim();
}

function repo(name: string, commit = true): string {
  const dir = scratch(name);
  dirs.push(dir);
  git(dir, "init", "-q");
  if (commit) git(dir, "commit", "-q", "--allow-empty", "-m", "first");
  return dir;
}

// The real runner uses the user's git config; the scratch repos need none, and the system one is harmless.
describe.skipIf(!HAS_GIT)("gitInfo against real repos", () => {
  test("clean, then dirty with an untracked file, then detached", () => {
    const dir = repo("build-git");
    const branch = git(dir, "branch", "--show-current");
    const commit = git(dir, "rev-parse", "--short", "HEAD");
    expect(gitInfo(dir)).toEqual({ branch, commit, dirty: false });
    writeFileSync(join(dir, "new.txt"), "x");
    expect(gitInfo(dir)).toEqual({ branch, commit, dirty: true });
    rmSync(join(dir, "new.txt"));
    git(dir, "checkout", "-q", "--detach");
    expect(gitInfo(dir)).toEqual({ branch: null, commit, dirty: false });
  });

  test("a repo with no commit has no commit nor branch", () => {
    const dir = repo("build-git-empty", false);
    expect(gitInfo(dir)).toMatchObject({ branch: null, commit: null });
  });

  test("a folder that is not a repo, or a subfolder of one, gives all null", () => {
    const plain = scratch("build-plain");
    dirs.push(plain);
    const none = { branch: null, commit: null, dirty: null };
    expect(gitInfo(plain)).toEqual(none);
    const dir = repo("build-git-sub");
    const sub = join(dir, "sub");
    mkdirSync(sub);
    expect(gitInfo(sub)).toEqual(none);
  });
});

describe("gitInfo without git", () => {
  test("a runner that finds nothing gives all null", () => {
    expect(gitInfo("/nowhere", () => null)).toEqual({ branch: null, commit: null, dirty: null });
  });
});

describe("buildDate", () => {
  const now = new Date("2026-11-01T10:20:31.987Z");
  test("SOURCE_DATE_EPOCH wins when valid", () => {
    expect(buildDate({ SOURCE_DATE_EPOCH: "1700000000" }, now)).toBe("2023-11-14T22:13:20Z");
  });
  test("invalid or absent: now, without milliseconds", () => {
    expect(buildDate({}, now)).toBe("2026-11-01T10:20:31Z");
    expect(buildDate({ SOURCE_DATE_EPOCH: "soon" }, now)).toBe("2026-11-01T10:20:31Z");
    expect(buildDate({ SOURCE_DATE_EPOCH: "" }, now)).toBe("2026-11-01T10:20:31Z");
  });
});

describe("buildInfoDefine", () => {
  test("double encoding round-trips", () => {
    const info = { branch: "v1", commit: "abc1234", dirty: true, built_at: "2026-11-01T10:20:31Z" };
    const value = buildInfoDefine(info);
    expect(JSON.parse(JSON.parse(value))).toEqual(info);
  });
});

describe("installDefine", () => {
  test("the npm bundle and the binary say what they are", () => {
    expect(installDefine("npm")).toBe('WIP_INSTALL="npm"');
    expect(installDefine("binary")).toBe('WIP_INSTALL="binary"');
  });
});

describe("mainPackageJson", () => {
  const template = { version: "0.0.0", name: "@garndev/wip", bin: { wip: "bin/wip.mjs" } };

  test("keeps the command `wip` by default", () => {
    expect(mainPackageJson(template, "1.2.3").bin).toEqual({ wip: "bin/wip.mjs" });
  });

  test("renames only the command, not the package or the bin file", () => {
    const pkg = mainPackageJson(template, "1.2.3", "wip2");
    expect(pkg.bin).toEqual({ wip2: "bin/wip.mjs" });
    expect(pkg.name).toBe("@garndev/wip");
    expect(pkg.version).toBe("1.2.3");
  });

  test("the template has no dependencies, needs Node 22.13 and ships only bin, dist, README and LICENSE", () => {
    const real = JSON.parse(readFileSync(join(REPO, "npm", "wip", "package.json"), "utf8")) as {
      [key: string]: unknown;
    };
    expect(real.dependencies).toBeUndefined();
    expect(real.optionalDependencies).toBeUndefined();
    expect(real.private).toBeUndefined();
    expect(real.engines).toEqual({ node: ">=22.13.0" });
    expect(real.files).toEqual(["bin", "dist", "README.md", "LICENSE"]);
    expect(real.bin).toEqual({ wip: "bin/wip.mjs" });
    expect(real.type).toBe("module");
  });
});

describe("release assets", () => {
  test("a .tar.gz per Unix target and a .zip for Windows", () => {
    expect(archiveName("1.2.3", { os: "darwin", arch: "arm64" })).toBe(
      "wip-1.2.3-darwin-arm64.tar.gz",
    );
    expect(archiveName("1.2.3", { os: "windows", arch: "x64" })).toBe("wip-1.2.3-windows-x64.zip");
  });

  test("SHA256SUMS lists each file by name, sorted, in the format shasum -c reads", () => {
    const dir = scratch("build-sums");
    dirs.push(dir);
    writeFileSync(join(dir, "b.tar.gz"), "b");
    writeFileSync(join(dir, "a.zip"), "");
    expect(sha256sums([join(dir, "b.tar.gz"), join(dir, "a.zip")])).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  a.zip\n" +
        "3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d  b.tar.gz\n",
    );
  });

  test("listFiles walks the package folder with / separators", () => {
    const dir = scratch("build-files");
    dirs.push(dir);
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "wip.mjs"), "");
    writeFileSync(join(dir, "package.json"), "{}");
    expect(listFiles(dir)).toEqual(["bin/wip.mjs", "package.json"]);
    expect(PACKAGE_FILES).toContain("dist/wip.mjs");
  });
});
