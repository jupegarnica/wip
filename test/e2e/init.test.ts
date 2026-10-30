import { afterEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { FIRST_RUN_LINE } from "../../src/commands/init.ts";
import { GENERIC_AGENTS, TEMPLATES } from "../../src/embedded/templates.ts";
import { EXIT } from "../../src/errors.ts";
import { type IEnvelopeOut, wipIn, wipJsonIn } from "../helpers/bin.ts";
import { scratch } from "../helpers/project.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(name: string): string {
  const dir = scratch(`init-${name}`);
  dirs.push(dir);
  return dir;
}

/** Every file under `root` with its text (a link, with its target), sorted: equal maps, unchanged tree. */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const key = relative(root, path).split("\\").join("/");
      if (entry.isSymbolicLink()) out[key] = `-> ${readlinkSync(path)}`;
      else if (entry.isDirectory()) walk(path);
      else out[key] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function lines(stdout: string): string[] {
  return stdout.trimEnd().split("\n");
}

interface IInitFileOut {
  path: string;
  action: string;
  backup: string | null;
}

function initFiles(out: IEnvelopeOut): IInitFileOut[] {
  const files = out.body.data?.files;
  return Array.isArray(files) ? (files as IInitFileOut[]) : [];
}

function genericFile(dir: string, name: string): string {
  return join(dir, ".agents", "agents", `${name}.md`);
}

describe("wip init in an empty directory (F-NEW-01)", () => {
  test("creates .wip/, .gitignore and every template from the manifest, and lints them", () => {
    const dir = tmp("empty");
    const out = wipIn(dir, ["init"]);
    expect(out.code).toBe(EXIT.OK);
    expect(existsSync(join(dir, ".wip"))).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".wip/\n");
    const agents = tree(join(dir, ".agents"));
    expect(agents).toEqual(
      Object.fromEntries(Object.entries(TEMPLATES).sort(([a], [b]) => a.localeCompare(b))),
    );
    for (const key of Object.keys(TEMPLATES))
      expect(out.stdout).toContain(`created .agents/${key}`);
    expect(out.stdout).toContain("flow lint: OK wip");
    expect(lines(out.stdout).at(-1)).toBe(FIRST_RUN_LINE);
    expect(wipIn(dir, ["flow", "lint"]).code).toBe(EXIT.OK);
  });

  test("a second run changes nothing and says exists of every file", () => {
    const dir = tmp("twice");
    expect(wipIn(dir, ["init"]).code).toBe(EXIT.OK);
    const before = tree(dir);
    const out = wipIn(dir, ["init"]);
    expect(out.code).toBe(EXIT.OK);
    expect(tree(dir)).toEqual(before);
    for (const key of Object.keys(TEMPLATES)) expect(out.stdout).toContain(`exists .agents/${key}`);
    expect(out.stdout).toContain("exists .wip/ in .gitignore");
    expect(out.stdout).not.toContain("created ");
  });

  test("init <path> works on another directory, creating it", () => {
    const dir = tmp("path");
    const { code, body } = wipJsonIn(dir, ["init", "sub/project"]);
    expect(code).toBe(EXIT.OK);
    const project = join(dir, "sub", "project");
    expect(body.data?.project).toBe(project);
    expect(existsSync(join(project, ".agents", "flows", "wip.md"))).toBe(true);
    expect(readdirSync(dir)).toEqual(["sub"]);
    expect(wipIn(project, ["flow", "lint"]).code).toBe(EXIT.OK);
  });
});

describe("wip init in a git repository with a .gitignore", () => {
  function gitRepo(name: string, gitignore: string): string {
    const dir = tmp(name);
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: dir }).exitCode).toBe(0);
    writeFileSync(join(dir, ".gitignore"), gitignore);
    return dir;
  }

  test("appends .wip/ on its own line and git ignores the state", () => {
    const dir = gitRepo("git", "node_modules");
    expect(wipIn(dir, ["init"]).stdout).toContain("added .wip/ to .gitignore");
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules\n.wip/\n");
    const ignored = Bun.spawnSync(["git", "check-ignore", "-q", ".wip/wip.sqlite"], { cwd: dir });
    expect(ignored.exitCode).toBe(0);
  });

  test("an existing .wip entry is not duplicated", () => {
    for (const entry of [".wip/", "/.wip", ".wip"]) {
      const dir = gitRepo("git-dup", `dist\n${entry}\n`);
      expect(wipIn(dir, ["init"]).code).toBe(EXIT.OK);
      expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(`dist\n${entry}\n`);
    }
  });
});

describe("wip init --force and agents of other tools", () => {
  test("--force backs up what it replaces and keeps the model of a generic", () => {
    const dir = tmp("force");
    wipIn(dir, ["init"]);
    const fast = genericFile(dir, "fast");
    writeFileSync(
      fast,
      readFileSync(fast, "utf8").replace("wip: generic", "wip: generic\nmodel: cheap"),
    );
    writeFileSync(genericFile(dir, "thinker"), `${TEMPLATES["agents/thinker.md"]}\nLocal edit.\n`);
    const rules = join(dir, ".agents", "rules", "subagents.md");
    writeFileSync(rules, "edited\n");

    const forced = wipJsonIn(dir, ["init", "--force"]);
    expect(forced.code).toBe(EXIT.OK);
    const files = initFiles(forced);
    const replaced = files.filter((f) => f.action === "replaced").map((f) => f.path);
    expect(replaced).toEqual([
      ".agents/agents/fast.md",
      ".agents/agents/thinker.md",
      ".agents/rules/subagents.md",
    ]);
    for (const f of files.filter((x) => x.action === "replaced")) {
      expect(f.backup).toStartWith(`.wip/backups/defs/${f.path.slice(".agents/".length)}.`);
      expect(existsSync(join(dir, f.backup as string))).toBe(true);
    }
    expect(readFileSync(rules, "utf8")).toBe(TEMPLATES["rules/subagents.md"] as string);
    expect(readFileSync(genericFile(dir, "thinker"), "utf8")).toBe(
      TEMPLATES["agents/thinker.md"] as string,
    );
    const fastText = readFileSync(fast, "utf8");
    expect(fastText).toContain("\nmodel: cheap\n");
    expect(fastText.replace("model: cheap\n", "")).toBe(TEMPLATES["agents/fast.md"] as string);

    const before = tree(dir);
    const again = wipJsonIn(dir, ["init", "--force"]);
    expect(initFiles(again).every((f) => f.action === "exists")).toBe(true);
    expect(tree(dir)).toEqual(before);
  });

  test("a generic's file without wip: generic is a conflict: exit 3, nothing written, the file named", () => {
    const dir = tmp("foreign");
    const foreign = "---\nname: fast\ndescription: another tool's agent\n---\n\nTheirs.\n";
    mkdirSync(join(dir, ".agents", "agents"), { recursive: true });
    writeFileSync(genericFile(dir, "fast"), foreign);
    const before = tree(dir);

    const out = wipIn(dir, ["init"]);
    expect(out.code).toBe(EXIT.REJECTED);
    expect(out.stderr).toContain(".agents/agents/fast.md");
    expect(out.stderr).toContain("wip: generic");
    expect(tree(dir)).toEqual(before);
    expect(existsSync(join(dir, ".wip"))).toBe(false);
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);

    const forced = wipJsonIn(dir, ["init", "--force"]);
    expect(forced.code).toBe(EXIT.OK);
    const fast = initFiles(forced).find((f) => f.path === ".agents/agents/fast.md");
    expect(readFileSync(join(dir, fast?.backup ?? "missing"), "utf8")).toBe(foreign);
    expect(readFileSync(genericFile(dir, "fast"), "utf8")).toBe(
      TEMPLATES["agents/fast.md"] as string,
    );
  });
});

describe("wip init --runtime (F-NEW-02)", () => {
  const LINKS = [
    [".claude/agents", ".agents/agents"],
    [".claude/skills", ".agents/skills"],
  ] as const;

  test("claude-code creates the two relative links and nothing else; a second run is a no-op", () => {
    const dir = tmp("claude");
    const out = wipIn(dir, ["init", "--runtime", "claude-code"]);
    expect(out.code).toBe(EXIT.OK);
    for (const [path, target] of LINKS) {
      const link = join(dir, path);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(resolve(dirname(link), readlinkSync(link))).toBe(join(dir, target));
      if (process.platform !== "win32") expect(readlinkSync(link)).toBe(`../${target}`);
      expect(out.stdout).toContain(`linked ${path} -> ../${target}`);
    }
    expect(readdirSync(join(dir, ".claude")).sort()).toEqual(["agents", "skills"]);
    expect(readFileSync(join(dir, ".claude", "agents", "fast.md"), "utf8")).toBe(
      TEMPLATES["agents/fast.md"] as string,
    );
    expect(existsSync(join(dir, ".claude", "skills", "wip-coordinate", "SKILL.md"))).toBe(true);
    expect(out.stdout).toContain("claude --agent wip-coordinator");
    expect(lines(out.stdout).at(-1)).toBe(FIRST_RUN_LINE);

    const before = tree(dir);
    const again = wipIn(dir, ["init", "--runtime", "claude-code"]);
    expect(again.code).toBe(EXIT.OK);
    for (const [path] of LINKS) expect(again.stdout).toContain(`exists ${path} -> `);
    expect(tree(dir)).toEqual(before);
  });

  test("a real .claude/agents directory is left alone: exit 3 and nothing written", () => {
    const dir = tmp("claude-dir");
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    writeFileSync(join(dir, ".claude", "agents", "mine.md"), "mine\n");
    const out = wipIn(dir, ["init", "--runtime", "claude-code", "--force"]);
    expect(out.code).toBe(EXIT.REJECTED);
    expect(out.stderr).toContain(".claude/agents is a directory");
    expect(existsSync(join(dir, ".wip"))).toBe(false);
    expect(existsSync(join(dir, ".agents"))).toBe(false);
    expect(readdirSync(join(dir, ".claude", "agents"))).toEqual(["mine.md"]);
  });

  test("another runtime, or none, prints how to point it at .agents/ and links nothing", () => {
    for (const argv of [["init"], ["init", "--runtime", "codex"]]) {
      const dir = tmp("other-runtime");
      const out = wipIn(dir, argv);
      expect(out.code).toBe(EXIT.OK);
      expect(out.stdout).toContain("Point your runtime at .agents/:");
      expect(out.stdout).toContain("wip init --runtime claude-code");
      expect(existsSync(join(dir, ".claude"))).toBe(false);
      expect(lines(out.stdout).at(-1)).toBe(FIRST_RUN_LINE);
    }
  });
});

describe("model onboarding after init (F-NEW-07)", () => {
  function modelsUnset(dir: string): { code: number; agents: unknown } {
    const { code, body } = wipJsonIn(dir, ["check"]);
    return { code, agents: body.warnings.find((w) => w.code === "models_unset")?.agents ?? null };
  }

  /** What the coordinator does: backup, then `model:` right after `description:`, nothing else. */
  function setModel(dir: string, name: string, model: string): string {
    const file = genericFile(dir, name);
    const backup = join(dir, ".wip", "backups", "defs", "agents", `${name}.md.20261030T120000Z`);
    mkdirSync(dirname(backup), { recursive: true });
    copyFileSync(file, backup);
    const out = readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line) => (line.startsWith("description:") ? [line, `model: ${model}`] : [line]));
    writeFileSync(file, out.join("\n"));
    return backup;
  }

  test("check warns models_unset with the four generics, and stops once each has a model", () => {
    const dir = tmp("onboarding");
    wipIn(dir, ["init"]);
    expect(modelsUnset(dir)).toEqual({ code: EXIT.OK, agents: [...GENERIC_AGENTS].sort() });

    setModel(dir, "fast", "test-model");
    setModel(dir, "wise", "test-model");
    expect(modelsUnset(dir).agents).toEqual(["efficient", "thinker"]);

    for (const name of ["efficient", "thinker"]) setModel(dir, name, "test-model");
    expect(modelsUnset(dir)).toEqual({ code: EXIT.OK, agents: null });
    expect(wipIn(dir, ["flow", "lint"]).code).toBe(EXIT.OK);
    expect(wipIn(dir, ["check"]).stdout).toBe("OK: no findings\n");

    for (const name of GENERIC_AGENTS) {
      const backup = join(dir, ".wip", "backups", "defs", "agents", `${name}.md.20261030T120000Z`);
      const before = readFileSync(backup, "utf8").split("\n");
      const after = readFileSync(genericFile(dir, name), "utf8").split("\n");
      expect(after.length).toBe(before.length + 1);
      expect(after.filter((line) => !before.includes(line))).toEqual(["model: test-model"]);
    }
  });

  test("init --force after the onboarding keeps every model and the warning stays away", () => {
    const dir = tmp("onboarding-force");
    wipIn(dir, ["init"]);
    for (const name of GENERIC_AGENTS) setModel(dir, name, "test-model");
    expect(wipIn(dir, ["init", "--force"]).code).toBe(EXIT.OK);
    expect(modelsUnset(dir).agents).toBeNull();
  });
});
