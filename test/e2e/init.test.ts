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
import { dirname, join, relative } from "node:path";
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

/** Every symbolic link under `root`, relative. */
function links(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (lstatSync(path).isSymbolicLink()) found.push(relative(root, path));
      else if (entry.isDirectory()) walk(path);
    }
  };
  walk(root);
  return found;
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

function agentFile(dir: string, name: string, defs = ".agents"): string {
  return join(dir, defs, "agents", `${name}.md`);
}

function config(dir: string): unknown {
  return JSON.parse(readFileSync(join(dir, ".wip", "config.json"), "utf8"));
}

const sortedTemplates = (): Record<string, string> =>
  Object.fromEntries(Object.entries(TEMPLATES).sort(([a], [b]) => a.localeCompare(b)));

describe("wip init in an empty directory (F-NEW-01)", () => {
  test("creates .wip/, its config, .gitignore and every template in .agents/, and lints them", () => {
    const dir = tmp("empty");
    const out = wipIn(dir, ["init"]);
    expect(out.code).toBe(EXIT.OK);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".wip/\n");
    expect(config(dir)).toEqual({ defs_dir: ".agents", harness: null });
    expect(tree(join(dir, ".agents"))).toEqual(sortedTemplates());
    for (const key of Object.keys(TEMPLATES))
      expect(out.stdout).toContain(`created .agents/${key}`);
    expect(out.stdout).toContain("created .wip/config.json (definitions in .agents/)");
    expect(out.stdout).toContain("flow lint: OK tasks");
    expect(out.stdout).toContain("seeded item onboarding (tasks · intake)");
    expect(out.stdout).toContain("Point your harness at .agents/:");
    expect(out.stdout).toContain("wip init --harness claude-code");
    expect(lines(out.stdout).at(-1)).toBe(FIRST_RUN_LINE);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
    expect(existsSync(join(dir, ".agents", "rules"))).toBe(false);
    expect(existsSync(join(dir, ".agents", "flows"))).toBe(false);
    expect(wipIn(dir, ["flow", "lint"]).stdout).toBe("OK tasks\n");
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
    expect(out.stdout).toContain("exists .wip/config.json");
    expect(out.stdout).not.toContain("created ");
  });

  test("init <path> works on another directory, creating it", () => {
    const dir = tmp("path");
    const { code, body } = wipJsonIn(dir, ["init", "sub/project"]);
    expect(code).toBe(EXIT.OK);
    const project = join(dir, "sub", "project");
    expect(body.data?.project).toBe(project);
    expect(existsSync(join(project, ".agents", "skills", "wip-flow-tasks", "SKILL.md"))).toBe(true);
    expect(readdirSync(dir)).toEqual(["sub"]);
    expect(wipIn(project, ["flow", "lint"]).code).toBe(EXIT.OK);
  });

  test("a harness without native support writes .agents/ and keeps its name in the config", () => {
    const dir = tmp("codex");
    const { code, body } = wipJsonIn(dir, ["init", "--harness", "codex"]);
    expect(code).toBe(EXIT.OK);
    expect(body.data).toMatchObject({ defs_dir: ".agents", harness: "codex" });
    expect(config(dir)).toEqual({ defs_dir: ".agents", harness: "codex" });
    expect(existsSync(join(dir, ".claude"))).toBe(false);
    expect(wipIn(dir, ["init", "--harness", ""]).code).toBe(EXIT.USAGE);
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

describe("wip init --force and files of other tools", () => {
  test("--force backs up what it replaces and keeps only the model of wip's agents", () => {
    const dir = tmp("force");
    wipIn(dir, ["init"]);
    const fast = agentFile(dir, "fast");
    writeFileSync(
      fast,
      readFileSync(fast, "utf8").replace("wip: generic", "wip: generic\nmodel: cheap"),
    );
    writeFileSync(agentFile(dir, "thinker"), `${TEMPLATES["agents/thinker.md"]}\nLocal edit.\n`);
    const protocol = join(dir, ".agents", "skills", "wip-subagent-protocol", "SKILL.md");
    writeFileSync(protocol, `${TEMPLATES["skills/wip-subagent-protocol/SKILL.md"]}\nedited\n`);
    const coordinator = agentFile(dir, "wip");
    const custom = readFileSync(coordinator, "utf8").replace(
      /^initialPrompt: .*$/m,
      'initialPrompt: "my own start"',
    );
    writeFileSync(coordinator, custom);

    const forced = wipJsonIn(dir, ["init", "--force"]);
    expect(forced.code).toBe(EXIT.OK);
    const files = initFiles(forced);
    const replaced = files.filter((f) => f.action === "replaced").map((f) => f.path);
    expect(replaced).toEqual([
      ".agents/agents/fast.md",
      ".agents/agents/thinker.md",
      ".agents/agents/wip.md",
      ".agents/skills/wip-subagent-protocol/SKILL.md",
    ]);
    for (const f of files.filter((x) => x.action === "replaced")) {
      expect(f.backup).toStartWith(`.wip/backups/defs/${f.path.slice(".agents/".length)}.`);
      expect(existsSync(join(dir, f.backup as string))).toBe(true);
    }
    const coordinatorBackup = files.find((f) => f.path === ".agents/agents/wip.md")?.backup;
    expect(readFileSync(join(dir, coordinatorBackup ?? "missing"), "utf8")).toBe(custom);
    expect(readFileSync(coordinator, "utf8")).toBe(TEMPLATES["agents/wip.md"] as string);
    expect(readFileSync(protocol, "utf8")).toBe(
      TEMPLATES["skills/wip-subagent-protocol/SKILL.md"] as string,
    );
    const fastText = readFileSync(fast, "utf8");
    expect(fastText).toContain("\nmodel: cheap\n");
    expect(fastText.replace("model: cheap\n", "")).toBe(TEMPLATES["agents/fast.md"] as string);

    const before = tree(dir);
    const again = wipJsonIn(dir, ["init", "--force"]);
    expect(initFiles(again).every((f) => f.action === "exists")).toBe(true);
    expect(tree(dir)).toEqual(before);
  });

  test("a file at a template's path without a wip: mark is a conflict, also with --force", () => {
    const dir = tmp("foreign");
    const foreign = "---\nname: fast\ndescription: another tool's agent\n---\n\nTheirs.\n";
    mkdirSync(join(dir, ".agents", "agents"), { recursive: true });
    writeFileSync(agentFile(dir, "fast"), foreign);
    mkdirSync(join(dir, ".agents", "skills", "wip-coordinate"), { recursive: true });
    writeFileSync(join(dir, ".agents", "skills", "wip-coordinate", "SKILL.md"), "mine\n");
    const before = tree(dir);

    for (const argv of [["init"], ["init", "--force"]]) {
      const out = wipIn(dir, argv);
      expect(out.code).toBe(EXIT.REJECTED);
      expect(out.stderr).toContain("nothing written");
      expect(out.stderr).toContain(".agents/agents/fast.md exists without a `wip:` mark");
      expect(out.stderr).toContain(".agents/skills/wip-coordinate/SKILL.md exists without");
      expect(tree(dir)).toEqual(before);
      expect(existsSync(join(dir, ".wip"))).toBe(false);
      expect(existsSync(join(dir, ".gitignore"))).toBe(false);
    }
  });

  test("a coordinator without its mark is another tool's: exit 3, not replaced", () => {
    const dir = tmp("foreign-coordinator");
    wipIn(dir, ["init"]);
    const file = agentFile(dir, "wip");
    writeFileSync(file, readFileSync(file, "utf8").replace("wip: coordinator\n", ""));
    const before = tree(dir);
    const out = wipIn(dir, ["init", "--force"]);
    expect(out.code).toBe(EXIT.REJECTED);
    expect(out.stderr).toContain(".agents/agents/wip.md exists without a `wip:` mark");
    expect(tree(dir)).toEqual(before);
  });
});

describe("wip init --harness claude-code (F-NEW-02)", () => {
  test("writes straight into .claude/agents and .claude/skills: no .agents/, no links", () => {
    const dir = tmp("claude");
    const out = wipJsonIn(dir, ["init", "--harness", "claude-code"]);
    expect(out.code).toBe(EXIT.OK);
    expect(out.body.data).toMatchObject({ defs_dir: ".claude", harness: "claude-code" });
    expect(config(dir)).toEqual({ defs_dir: ".claude", harness: "claude-code" });
    expect(tree(join(dir, ".claude"))).toEqual(sortedTemplates());
    expect(existsSync(join(dir, ".agents"))).toBe(false);
    expect(links(dir)).toEqual([]);
    expect(readdirSync(join(dir, ".claude")).sort()).toEqual(["agents", "skills"]);

    const text = wipIn(dir, ["init", "--harness", "claude-code"]);
    expect(text.code).toBe(EXIT.OK);
    expect(text.stdout).toContain("exists .claude/agents/fast.md");
    expect(text.stdout).toContain("flow lint: OK tasks");
    expect(text.stdout).toContain("`claude --agent wip` in this directory");
    expect(text.stdout).not.toContain('"start"');
    expect(text.stdout).not.toContain("Point your harness");
    expect(lines(text.stdout).at(-1)).toBe(FIRST_RUN_LINE);
  });

  test("every command reads .claude/: flow lint, check and phase", () => {
    const dir = tmp("claude-reads");
    wipIn(dir, ["init", "--harness", "claude-code"]);
    expect(wipIn(dir, ["flow", "lint"]).stdout).toBe("OK tasks\n");
    const check = wipJsonIn(dir, ["check"]);
    expect(check.code).toBe(EXIT.OK);
    expect(check.body.warnings.find((w) => w.code === "models_unset")?.agents).toEqual(
      [...GENERIC_AGENTS, "wip"].sort(),
    );
    expect(wipJsonIn(dir, ["phase", "T1", "intake"]).code).toBe(EXIT.OK);
    expect(wipJsonIn(dir, ["agent", "start", "T1", "fast"]).code).toBe(EXIT.OK);
  });

  test("other tools' agents and skills in .claude/ stay; wip writes next to them", () => {
    const dir = tmp("claude-shared");
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    mkdirSync(join(dir, ".claude", "skills", "mine"), { recursive: true });
    writeFileSync(join(dir, ".claude", "agents", "mine.md"), "mine\n");
    writeFileSync(join(dir, ".claude", "skills", "mine", "SKILL.md"), "mine\n");
    writeFileSync(join(dir, ".claude", "settings.json"), "{}\n");
    const out = wipIn(dir, ["init", "--harness", "claude-code", "--force"]);
    expect(out.code).toBe(EXIT.OK);
    expect(readFileSync(join(dir, ".claude", "agents", "mine.md"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(dir, ".claude", "skills", "mine", "SKILL.md"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(dir, ".claude", "settings.json"), "utf8")).toBe("{}\n");
    expect(existsSync(join(dir, ".claude", "agents", "fast.md"))).toBe(true);
    expect(wipIn(dir, ["flow", "lint"]).code).toBe(EXIT.OK);
  });

  test("a name clash in .claude/ with a file without the mark is exit 3 and nothing written", () => {
    const dir = tmp("claude-clash");
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    writeFileSync(agentFile(dir, "wip", ".claude"), "---\nname: wip\ndescription: mine\n---\n");
    const before = tree(dir);
    const out = wipIn(dir, ["init", "--harness", "claude-code", "--force"]);
    expect(out.code).toBe(EXIT.REJECTED);
    expect(out.stderr).toContain(".claude/agents/wip.md exists without a `wip:` mark");
    expect(tree(dir)).toEqual(before);
    expect(existsSync(join(dir, ".wip"))).toBe(false);
  });

  test("--force in .claude/ backs up into .wip/backups/defs/ and keeps the model", () => {
    const dir = tmp("claude-force");
    wipIn(dir, ["init", "--harness", "claude-code"]);
    const wise = agentFile(dir, "wise", ".claude");
    writeFileSync(
      wise,
      readFileSync(wise, "utf8").replace("wip: generic", "wip: generic\nmodel: opus"),
    );
    writeFileSync(
      join(dir, ".claude", "skills", "wip-flow-tasks", "SKILL.md"),
      `${TEMPLATES["skills/wip-flow-tasks/SKILL.md"]}\nLocal.\n`,
    );
    const forced = wipJsonIn(dir, ["init", "--harness", "claude-code", "--force"]);
    expect(forced.code).toBe(EXIT.OK);
    const replaced = initFiles(forced).filter((f) => f.action === "replaced");
    expect(replaced.map((f) => [f.path, f.backup?.replace(/\.\d{8}T\d{6}Z$/, "")])).toEqual([
      [".claude/agents/wise.md", ".wip/backups/defs/agents/wise.md"],
      [
        ".claude/skills/wip-flow-tasks/SKILL.md",
        ".wip/backups/defs/skills/wip-flow-tasks/SKILL.md",
      ],
    ]);
    expect(readFileSync(wise, "utf8")).toContain("\nmodel: opus\n");
  });

  test("a project keeps its folder: init with another harness is exit 3 and writes nothing", () => {
    const plain = tmp("keep-plain");
    wipIn(plain, ["init"]);
    const plainBefore = tree(plain);
    const toClaude = wipIn(plain, ["init", "--harness", "claude-code", "--force"]);
    expect(toClaude.code).toBe(EXIT.REJECTED);
    expect(toClaude.stderr).toContain("keeps its definitions in .agents/");
    expect(toClaude.stderr).toContain("run `wip init`");
    expect(tree(plain)).toEqual(plainBefore);
    expect(existsSync(join(plain, ".claude"))).toBe(false);

    const cc = tmp("keep-claude");
    wipIn(cc, ["init", "--harness", "claude-code"]);
    const ccBefore = tree(cc);
    for (const argv of [["init"], ["init", "--harness", "codex", "--force"]]) {
      const out = wipIn(cc, argv);
      expect(out.code).toBe(EXIT.REJECTED);
      expect(out.stderr).toContain("keeps its definitions in .claude/");
      expect(out.stderr).toContain("run `wip init --harness claude-code`");
      expect(tree(cc)).toEqual(ccBefore);
      expect(existsSync(join(cc, ".agents"))).toBe(false);
    }
  });
});

describe("the onboarding item seeded by init (F-NEW-08)", () => {
  function items(dir: string, argv: readonly string[] = ["state"]): unknown[][] {
    const rows = (wipJsonIn(dir, argv).body.data?.items ?? []) as Record<string, unknown>[];
    return rows.map((r) => [r.id, r.flow, r.phase, r.waiting_on, r.title]);
  }
  const ONBOARDING = ["onboarding", "tasks", "intake", "user", "Get to know wip"];

  for (const argv of [["init"], ["init", "--harness", "claude-code"]]) {
    test(`${argv.join(" ")} seeds it once; a second init and --force do not duplicate it`, () => {
      const dir = tmp("seed");
      const first = wipJsonIn(dir, argv);
      expect(first.code).toBe(EXIT.OK);
      expect(first.body.data?.items).toEqual([
        { id: "onboarding", flow: "tasks", phase: "intake", action: "seeded" },
      ]);
      expect(wipIn(dir, argv).stdout).toContain("exists item onboarding (tasks · intake)");
      const forced = wipJsonIn(dir, [...argv, "--force"]);
      expect(forced.code).toBe(EXIT.OK);
      expect(forced.body.data?.items).toEqual([
        { id: "onboarding", flow: "tasks", phase: "intake", action: "exists" },
      ]);
      expect(items(dir)).toEqual([ONBOARDING]);
      expect(items(dir, ["state", "--attention"])).toEqual([ONBOARDING]);
      const check = wipJsonIn(dir, ["check"]);
      expect(check.code).toBe(EXIT.OK);
      expect(check.body.data?.findings).toEqual([]);
      const shown = wipJsonIn(dir, ["show", "onboarding"]).body;
      expect(existsSync(String(shown.item?.artifact_dir))).toBe(true);
    });
  }

  test("an onboarding moved on by the user is not revived by init --force", () => {
    const dir = tmp("seed-moved");
    wipIn(dir, ["init"]);
    expect(wipJsonIn(dir, ["log", "onboarding", "seen", "--kind", "user"]).code).toBe(EXIT.OK);
    expect(wipJsonIn(dir, ["phase", "onboarding", "done"]).code).toBe(EXIT.OK);
    expect(wipIn(dir, ["init", "--force"]).code).toBe(EXIT.OK);
    expect(items(dir)).toEqual([["onboarding", "tasks", "done", "none", "Get to know wip"]]);
    expect(wipJsonIn(dir, ["archive", "onboarding"]).code).toBe(EXIT.OK);
    expect(wipIn(dir, ["init"]).stdout).toContain("exists item onboarding");
    expect(items(dir)).toEqual([]);
  });

  test("a flow without seed creates no database", () => {
    const dir = tmp("seed-none");
    mkdirSync(join(dir, ".agents", "skills", "wip-flow-tasks"), { recursive: true });
    const flow = join(dir, ".agents", "skills", "wip-flow-tasks", "SKILL.md");
    const text = TEMPLATES["skills/wip-flow-tasks/SKILL.md"] as string;
    writeFileSync(flow, text.replace(/^seed:\n(?: {2}.*\n)+/m, ""));
    const out = wipJsonIn(dir, ["init"]);
    expect(out.code).toBe(EXIT.OK);
    expect(out.body.data?.items).toEqual([]);
    expect(existsSync(join(dir, ".wip", "wip.sqlite"))).toBe(false);
  });
});

describe("model onboarding after init (F-NEW-07)", () => {
  function modelsUnset(dir: string): { code: number; agents: unknown } {
    const { code, body } = wipJsonIn(dir, ["check"]);
    return { code, agents: body.warnings.find((w) => w.code === "models_unset")?.agents ?? null };
  }

  /** What the coordinator does: backup, then `model:` right after `description:`, nothing else. */
  function setModel(dir: string, name: string, model: string): string {
    const file = agentFile(dir, name);
    const backup = join(dir, ".wip", "backups", "defs", "agents", `${name}.md.20261030T120000Z`);
    mkdirSync(dirname(backup), { recursive: true });
    copyFileSync(file, backup);
    const out = readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line) => (line.startsWith("description:") ? [line, `model: ${model}`] : [line]));
    writeFileSync(file, out.join("\n"));
    return backup;
  }

  const OWN_AGENTS = [...GENERIC_AGENTS, "wip"];

  test("check warns models_unset with the four generics and the coordinator, and stops once each has a model", () => {
    const dir = tmp("onboarding");
    wipIn(dir, ["init"]);
    expect(modelsUnset(dir)).toEqual({ code: EXIT.OK, agents: [...OWN_AGENTS].sort() });

    setModel(dir, "fast", "test-model");
    setModel(dir, "wise", "test-model");
    expect(modelsUnset(dir).agents).toEqual(["efficient", "thinker", "wip"]);

    for (const name of ["efficient", "thinker"]) setModel(dir, name, "test-model");
    expect(modelsUnset(dir).agents).toEqual(["wip"]);

    setModel(dir, "wip", "test-model");
    expect(modelsUnset(dir)).toEqual({ code: EXIT.OK, agents: null });
    expect(wipIn(dir, ["flow", "lint"]).code).toBe(EXIT.OK);
    expect(wipIn(dir, ["check"]).stdout).toBe("OK: no findings\n");

    for (const name of OWN_AGENTS) {
      const backup = join(dir, ".wip", "backups", "defs", "agents", `${name}.md.20261030T120000Z`);
      const before = readFileSync(backup, "utf8").split("\n");
      const after = readFileSync(agentFile(dir, name), "utf8").split("\n");
      expect(after.length).toBe(before.length + 1);
      expect(after.filter((line) => !before.includes(line))).toEqual(["model: test-model"]);
    }
  });

  test("init --force after the onboarding keeps every model and the warning stays away", () => {
    const dir = tmp("onboarding-force");
    wipIn(dir, ["init"]);
    for (const name of OWN_AGENTS) setModel(dir, name, "test-model");
    expect(wipIn(dir, ["init", "--force"]).code).toBe(EXIT.OK);
    expect(modelsUnset(dir).agents).toBeNull();
  });
});
