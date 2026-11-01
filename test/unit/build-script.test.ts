import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDate, buildInfoDefine, gitInfo } from "../../scripts/build.ts";
import { scratch } from "../helpers/project.ts";

const HAS_GIT = Bun.which("git") !== null;
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
