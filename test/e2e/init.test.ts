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
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { unsetLine } from "../../src/commands/init.ts";
import { KANBAN_MOD } from "../../src/embedded/kanban.ts";
import { GENERIC_AGENTS, TEMPLATES } from "../../src/embedded/templates.ts";
import { EXIT } from "../../src/errors.ts";
import { type IEnvelopeOut, WIP_BIN, wipIn, wipJsonIn } from "../helpers/bin.ts";
import { scratch } from "../helpers/project.ts";

const ALL_UNSET = unsetLine([...GENERIC_AGENTS, "wip"].sort(), true) as string;

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

function agentFile(dir: string, name: string, defs = ".claude"): string {
  return join(dir, defs, "agents", `${name}.md`);
}

/** The project's config; against a launcher (WIP_TEST_BIN), without the `wip_bin` it records as any launch does. */
function config(dir: string): unknown {
  const value = JSON.parse(readFileSync(join(dir, ".wip", "config.json"), "utf8"));
  if (WIP_BIN !== null) delete value.wip_bin;
  return value;
}

const sortedTemplates = (): Record<string, string> =>
  Object.fromEntries(Object.entries(TEMPLATES).sort(([a], [b]) => a.localeCompare(b)));

/** A project on the legacy `.agents/` folder: the config says so and the templates are there. */
function legacyProject(name: string, extra: Record<string, unknown> = {}): string {
  const dir = tmp(name);
  mkdirSync(join(dir, ".wip"), { recursive: true });
  writeFileSync(
    join(dir, ".wip", "config.json"),
    `${JSON.stringify({ defs_dir: ".agents", ...extra })}\n`,
  );
  for (const [key, text] of Object.entries(TEMPLATES)) {
    const file = join(dir, ".agents", key);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return dir;
}

describe("wip init in an empty directory (F-NEW-01)", () => {
  test("creates .wip/, its config, .gitignore and every template in .claude/, and lints them", () => {
    const dir = tmp("empty");
    const out = wipIn(dir, ["init"]);
    expect(out.code).toBe(EXIT.OK);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".wip/\n");
    expect(config(dir)).toEqual({ defs_dir: ".claude" });
    expect(tree(join(dir, ".claude"))).toEqual(sortedTemplates());
    for (const key of Object.keys(TEMPLATES))
      expect(out.stdout).toContain(`created .claude/${key}`);
    expect(out.stdout).toContain("created .wip/config.json (definitions in .claude/)");
    expect(out.stdout).toContain("flow lint: OK tasks");
    expect(out.stdout).toContain("seeded item onboarding (tasks · intake) with guide.md");
    expect(out.stdout).toContain("Run `wip start` (or bare `wip`) in this directory");
    expect(out.stdout).not.toContain("Point your harness");
    expect(out.stdout).not.toContain("--harness");
    expect(lines(out.stdout).at(-1)).toBe(ALL_UNSET);
    expect(existsSync(join(dir, ".agents"))).toBe(false);
    expect(existsSync(join(dir, ".claude", "rules"))).toBe(false);
    expect(existsSync(join(dir, ".claude", "flows"))).toBe(false);
    expect(wipIn(dir, ["flow", "lint"]).stdout).toBe("OK tasks\n");
  });

  test("a second run changes nothing and says exists of every file", () => {
    const dir = tmp("twice");
    expect(wipIn(dir, ["init"]).code).toBe(EXIT.OK);
    const before = tree(dir);
    const out = wipIn(dir, ["init"]);
    expect(out.code).toBe(EXIT.OK);
    expect(tree(dir)).toEqual(before);
    for (const key of Object.keys(TEMPLATES)) expect(out.stdout).toContain(`exists .claude/${key}`);
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
    expect(existsSync(join(project, ".claude", "skills", "wip-flow-tasks", "SKILL.md"))).toBe(true);
    expect(readdirSync(dir)).toEqual(["sub"]);
    expect(wipIn(project, ["flow", "lint"]).code).toBe(EXIT.OK);
  });

  test("--harness is gone: exit 2 and nothing written", () => {
    const dir = tmp("harness-gone");
    const out = wipIn(dir, ["init", "--harness", "claude-code"]);
    expect(out.code).toBe(EXIT.USAGE);
    expect(readdirSync(dir)).toEqual([]);
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
      `${readFileSync(fast, "utf8").replace(/^(description:.*)$/m, "$1\nmodel: cheap")}\nExtra.\n`,
    );
    writeFileSync(agentFile(dir, "thinker"), `${TEMPLATES["agents/thinker.md"]}\nLocal edit.\n`);
    const protocol = join(dir, ".claude", "skills", "wip-subagent-protocol", "SKILL.md");
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
      ".claude/agents/fast.md",
      ".claude/agents/thinker.md",
      ".claude/agents/wip.md",
      ".claude/skills/wip-subagent-protocol/SKILL.md",
    ]);
    for (const f of files.filter((x) => x.action === "replaced")) {
      expect(f.backup).toStartWith(`.wip/backups/defs/${f.path.slice(".claude/".length)}.`);
      expect(existsSync(join(dir, f.backup as string))).toBe(true);
    }
    const coordinatorBackup = files.find((f) => f.path === ".claude/agents/wip.md")?.backup;
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
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    writeFileSync(agentFile(dir, "fast"), foreign);
    mkdirSync(join(dir, ".claude", "skills", "wip-coordinate"), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", "wip-coordinate", "SKILL.md"), "mine\n");
    const before = tree(dir);

    for (const argv of [["init"], ["init", "--force"]]) {
      const out = wipIn(dir, argv);
      expect(out.code).toBe(EXIT.REJECTED);
      expect(out.stderr).toContain("nothing written");
      expect(out.stderr).toContain(".claude/agents/fast.md exists without a `wip:` mark");
      expect(out.stderr).toContain(".claude/skills/wip-coordinate/SKILL.md exists without");
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
    expect(out.stderr).toContain(".claude/agents/wip.md exists without a `wip:` mark");
    expect(tree(dir)).toEqual(before);
  });
});

describe("the definitions folder in .claude/ (F-NEW-02)", () => {
  test("writes straight into .claude/agents and .claude/skills: no .agents/, no links", () => {
    const dir = tmp("claude");
    const out = wipJsonIn(dir, ["init"]);
    expect(out.code).toBe(EXIT.OK);
    expect(out.body.data).toMatchObject({ defs_dir: ".claude" });
    expect(config(dir)).toEqual({ defs_dir: ".claude" });
    expect(tree(join(dir, ".claude"))).toEqual(sortedTemplates());
    expect(existsSync(join(dir, ".agents"))).toBe(false);
    expect(links(dir)).toEqual([]);
    expect(readdirSync(join(dir, ".claude")).sort()).toEqual(["agents", "skills"]);

    const text = wipIn(dir, ["init"]);
    expect(text.code).toBe(EXIT.OK);
    expect(text.stdout).toContain("exists .claude/agents/fast.md");
    expect(text.stdout).toContain("flow lint: OK tasks");
    expect(text.stdout).toContain("Run `wip start` (or bare `wip`) in this directory");
    expect(text.stdout).not.toContain('"start"');
    expect(text.stdout).not.toContain("Point your harness");
    expect(lines(text.stdout).at(-1)).toBe(ALL_UNSET);
  });

  test("every command reads .claude/: flow lint, check and phase", () => {
    const dir = tmp("claude-reads");
    wipIn(dir, ["init"]);
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
    const out = wipIn(dir, ["init", "--force"]);
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
    writeFileSync(agentFile(dir, "wip"), "---\nname: wip\ndescription: mine\n---\n");
    const before = tree(dir);
    const out = wipIn(dir, ["init", "--force"]);
    expect(out.code).toBe(EXIT.REJECTED);
    expect(out.stderr).toContain(".claude/agents/wip.md exists without a `wip:` mark");
    expect(tree(dir)).toEqual(before);
    expect(existsSync(join(dir, ".wip"))).toBe(false);
  });

  test("--force in .claude/ backs up into .wip/backups/defs/ and keeps the model", () => {
    const dir = tmp("claude-force");
    wipIn(dir, ["init"]);
    const wise = agentFile(dir, "wise", ".claude");
    writeFileSync(
      wise,
      `${readFileSync(wise, "utf8").replace(/^(description:.*)$/m, "$1\nmodel: opus")}\nExtra.\n`,
    );
    writeFileSync(
      join(dir, ".claude", "skills", "wip-flow-tasks", "SKILL.md"),
      `${TEMPLATES["skills/wip-flow-tasks/SKILL.md"]}\nLocal.\n`,
    );
    const forced = wipJsonIn(dir, ["init", "--force"]);
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
});

describe("wip init --force migrates a legacy .agents folder", () => {
  const CUSTOM_FLOW = (name: string): string =>
    `---\nname: wip-flow-${name}\ndescription: "flow ${name}"\nwip: flow\n---\n\n# ${name}\n\n\`\`\`wip-flow\nphases:\n  - name: todo\n    next: [done]\n  - name: done\n    kind: terminal\n\`\`\`\n`;

  function customFlow(dir: string, name: string, folder = ".agents"): void {
    const skill = join(dir, folder, "skills", `wip-flow-${name}`);
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, "SKILL.md"), CUSTOM_FLOW(name));
  }

  test(".agents -> .claude with --force: .claude is complete, .agents is byte-identical, config switches", () => {
    const dir = legacyProject("switch-claude");
    const agentsBefore = tree(join(dir, ".agents"));
    const out = wipIn(dir, ["init", "--force"]);
    expect(out.code).toBe(EXIT.OK);
    expect(tree(join(dir, ".claude"))).toEqual(sortedTemplates());
    expect(tree(join(dir, ".agents"))).toEqual(agentsBefore);
    expect(config(dir)).toEqual({ defs_dir: ".claude" });
    expect(out.stdout).toContain(
      "switched definitions from .agents/ to .claude/; .agents/ stays as it is and wip no longer reads it",
    );
    expect(wipIn(dir, ["flow", "lint"]).stdout).toBe("OK tasks\n");
    expect(wipJsonIn(dir, ["phase", "T1", "intake"]).code).toBe(EXIT.OK);
    expect(wipJsonIn(dir, ["agent", "start", "T1", "fast"]).code).toBe(EXIT.OK);
  });

  test("--json reports switched_from; a plain init reports null", () => {
    const dir = legacyProject("switch-json");
    const out = wipJsonIn(dir, ["init", "--force"]);
    expect(out.code).toBe(EXIT.OK);
    expect(out.body.data).toMatchObject({
      defs_dir: ".claude",
      switched_from: ".agents",
      config: "updated",
    });
    const plain = wipJsonIn(tmp("switch-json-none"), ["init"]);
    expect(plain.body.data?.switched_from).toBeNull();
  });

  test("a saved start is kept across the .agents -> .claude switch", () => {
    const saved = ["claude", "--agent", "wip", "--name", "wip-{stamp}"];
    const dir = legacyProject("switch-start", { start: saved });
    const out = wipIn(dir, ["init", "--force"]);
    expect(out.code).toBe(EXIT.OK);
    expect(config(dir)).toMatchObject({ defs_dir: ".claude", start: saved });
    expect(out.stdout).not.toContain("(kept)");
  });

  test("custom agents and skills of the old folder are not copied: defs_left_behind lists them", () => {
    const dir = legacyProject("switch-left");
    customFlow(dir, "zzz");
    writeFileSync(join(dir, ".agents", "agents", "mine.md"), "---\nname: mine\n---\nmine\n");
    const out = wipJsonIn(dir, ["init", "--force"]);
    expect(out.code).toBe(EXIT.OK);
    const left = out.body.warnings.find((w) => w.code === "defs_left_behind");
    expect(left?.message).toContain(".agents/agents/mine.md");
    expect(left?.message).toContain(".agents/skills/wip-flow-zzz/SKILL.md");
    expect(left?.message).not.toContain("fast.md");
    expect(left?.message).toContain("copy them by hand if you need them");
    expect(existsSync(join(dir, ".claude", "agents", "mine.md"))).toBe(false);
    expect(existsSync(join(dir, ".claude", "skills", "wip-flow-zzz"))).toBe(false);
    expect(readFileSync(join(dir, ".agents", "agents", "mine.md"), "utf8")).toBe(
      "---\nname: mine\n---\nmine\n",
    );
  });

  test("a live item whose flow the new folder lacks: exit 3 and nothing written; after the flow is copied, exit 0", () => {
    const dir = legacyProject("switch-live");
    customFlow(dir, "zzz");
    expect(wipIn(dir, ["phase", "Z1", "todo", "--flow", "zzz"]).code).toBe(EXIT.OK);
    const before = tree(dir);
    const out = wipIn(dir, ["init", "--force"]);
    expect(out.code).toBe(EXIT.REJECTED);
    expect(out.stderr).toContain(
      "item Z1 uses the flow zzz, which is in .agents/ and not in .claude/; copy skills/wip-flow-zzz/ to .claude/ by hand and run init again",
    );
    expect(existsSync(join(dir, ".claude"))).toBe(false);
    expect(config(dir)).toEqual({ defs_dir: ".agents" });
    expect(tree(dir)).toEqual(before);

    customFlow(dir, "zzz", ".claude");
    const ok = wipIn(dir, ["init", "--force"]);
    expect(ok.code).toBe(EXIT.OK);
    expect(wipIn(dir, ["flow", "lint", "zzz"]).code).toBe(EXIT.OK);
  });

  test("an archived item does not block the switch", () => {
    const dir = legacyProject("switch-archived");
    customFlow(dir, "zzz");
    expect(wipIn(dir, ["phase", "Z1", "todo", "--flow", "zzz"]).code).toBe(EXIT.OK);
    expect(wipIn(dir, ["phase", "Z1", "done", "--flow", "zzz"]).code).toBe(EXIT.OK);
    expect(wipIn(dir, ["archive", "Z1", "--no-prune"]).code).toBe(EXIT.OK);
    expect(wipIn(dir, ["init", "--force"]).code).toBe(EXIT.OK);
  });

  test("a foreign file at a template path of the new folder is still exit 3 with --force", () => {
    const dir = legacyProject("switch-foreign");
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    writeFileSync(join(dir, ".claude", "agents", "wip.md"), "---\nname: wip\n---\nmine\n");
    const before = tree(dir);
    const out = wipIn(dir, ["init", "--force"]);
    expect(out.code).toBe(EXIT.REJECTED);
    expect(out.stderr).toContain(".claude/agents/wip.md exists without a `wip:` mark");
    expect(tree(dir)).toEqual(before);
  });
});

describe("a project without config.json", () => {
  test("reads .claude", () => {
    const dir = tmp("no-config");
    mkdirSync(join(dir, ".wip"), { recursive: true });
    const skill = join(dir, ".claude", "skills", "wip-flow-x", "SKILL.md");
    mkdirSync(dirname(skill), { recursive: true });
    writeFileSync(
      skill,
      `---\nname: wip-flow-x\ndescription: "flow x"\n---\n\n\`\`\`wip-flow\nphases:\n  - name: todo\n    next: [done]\n  - name: done\n    kind: terminal\n\`\`\`\n`,
    );
    expect(wipIn(dir, ["flow", "lint", "x"]).stdout).toBe("OK x\n");
  });
});

describe("the onboarding item seeded by init (F-NEW-08)", () => {
  function items(dir: string, argv: readonly string[] = ["state"]): unknown[][] {
    const rows = (wipJsonIn(dir, argv).body.data?.items ?? []) as Record<string, unknown>[];
    return rows.map((r) => [r.id, r.flow, r.phase, r.waiting_on, r.title]);
  }
  const ONBOARDING = ["onboarding", "tasks", "intake", "user", "Get to know wip"];

  for (const [argv, defs] of [[["init"], ".claude"]] as const) {
    test(`${argv.join(" ")} seeds it once with its guide; a second init and --force do not duplicate it`, () => {
      const dir = tmp("seed");
      const first = wipJsonIn(dir, argv);
      expect(first.code).toBe(EXIT.OK);
      expect(first.body.data?.items).toEqual([
        { id: "onboarding", flow: "tasks", phase: "intake", action: "seeded", files: ["guide.md"] },
      ]);
      const shown = wipJsonIn(dir, ["show", "onboarding"]).body;
      const artifacts = String(shown.item?.artifact_dir);
      expect(shown.item?.next).toBe("tell the coordinator when you want to start the onboarding");
      const template = join(dir, defs, "skills", "wip-flow-tasks", "guide.md");
      expect(readFileSync(join(artifacts, "guide.md"), "utf8")).toBe(
        readFileSync(template, "utf8"),
      );
      expect(wipIn(dir, argv).stdout).toContain("exists item onboarding (tasks · intake)\n");
      const forced = wipJsonIn(dir, [...argv, "--force"]);
      expect(forced.code).toBe(EXIT.OK);
      expect(forced.body.data?.items).toEqual([
        { id: "onboarding", flow: "tasks", phase: "intake", action: "exists", files: [] },
      ]);
      expect(items(dir)).toEqual([ONBOARDING]);
      expect(items(dir, ["state", "--attention"])).toEqual([ONBOARDING]);
      const check = wipJsonIn(dir, ["check"]);
      expect(check.code).toBe(EXIT.OK);
      expect(check.body.data?.findings).toEqual([]);
    });
  }

  test("a guide edited in the item survives init --force", () => {
    const dir = tmp("seed-edited");
    wipIn(dir, ["init"]);
    const guide = join(dir, ".wip", "items", "tasks", "onboarding", "guide.md");
    writeFileSync(guide, "my notes\n");
    expect(wipIn(dir, ["init", "--force"]).code).toBe(EXIT.OK);
    expect(readFileSync(guide, "utf8")).toBe("my notes\n");
  });

  test("a flow whose seed names a missing file fails lint and seeds nothing", () => {
    const dir = tmp("seed-missing");
    mkdirSync(join(dir, ".claude", "skills", "wip-flow-tasks"), { recursive: true });
    const flow = join(dir, ".claude", "skills", "wip-flow-tasks", "SKILL.md");
    const text = TEMPLATES["skills/wip-flow-tasks/SKILL.md"] as string;
    writeFileSync(flow, text.replace("files: [guide.md]", "files: [missing.md]"));
    const out = wipJsonIn(dir, ["init"]);
    expect(out.code).toBe(EXIT.FINDINGS);
    expect(out.body.data?.items).toEqual([]);
    const lint = wipIn(dir, ["flow", "lint"]);
    expect(lint.stdout).toContain(
      "seed onboarding: file 'missing.md' is missing from .claude/skills/wip-flow-tasks/",
    );
    expect(existsSync(join(dir, ".wip", "items", "tasks", "onboarding"))).toBe(false);
  });

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
    mkdirSync(join(dir, ".claude", "skills", "wip-flow-tasks"), { recursive: true });
    const flow = join(dir, ".claude", "skills", "wip-flow-tasks", "SKILL.md");
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

  /** What the coordinator does: backup, then `model:` added right after `description:`, nothing else. */
  function setModel(dir: string, name: string, model: string): string {
    const file = agentFile(dir, name);
    const backup = join(dir, ".wip", "backups", "defs", "agents", `${name}.md.20261030T120000Z`);
    mkdirSync(dirname(backup), { recursive: true });
    copyFileSync(file, backup);
    const out = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !line.startsWith("model:"))
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

describe("wip init --global", () => {
  const NO_ENV = {};

  const home = (): string => tmp("home");
  const g = (dir: string, argv: readonly string[], h: string) => wipIn(dir, argv, { HOME: h });
  const gj = (dir: string, argv: readonly string[], h: string) => wipJsonIn(dir, argv, { HOME: h });
  const flowSkill = (name: string): string =>
    `---\nname: wip-flow-${name}\ndescription: "flow ${name}"\nwip: flow\n---\n\n# ${name}\n\n\`\`\`wip-flow\nphases:\n  - name: todo\n    next: [done]\n  - name: done\n    kind: terminal\n\`\`\`\n`;

  function twoProjects(): { h: string; a: string; b: string } {
    const h = home();
    const a = tmp("ga");
    const b = tmp("gb");
    expect(g(a, ["init", "--global"], h).code).toBe(EXIT.OK);
    return { h, a, b };
  }

  test("writes every template into $HOME/.claude and the state into the project", () => {
    const h = home();
    const dir = tmp("g1");
    const out = g(dir, ["init", "--global"], h);
    expect(out.code).toBe(EXIT.OK);
    expect(tree(join(h, ".claude"))).toEqual(sortedTemplates());
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".wip/\n");
    expect(out.stdout).toContain("seeded item onboarding (tasks · intake) with guide.md");
    expect(existsSync(join(dir, ".wip", "items", "tasks", "onboarding", "guide.md"))).toBe(true);
    expect(existsSync(join(dir, ".agents"))).toBe(false);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
    for (const key of Object.keys(TEMPLATES))
      expect(out.stdout).toContain(`created ${h}/.claude/${key}`);
    expect(out.stdout).not.toContain("~/.claude/");
  });

  test("the project keeps ~/.claude and every command reads it", () => {
    const h = home();
    const dir = tmp("g3");
    const out = g(dir, ["init", "--global"], h);
    expect(config(dir)).toEqual({ defs_dir: "~/.claude" });
    expect(out.stdout).toContain(
      `created .wip/config.json (definitions in ${h}/.claude/, shared by every --global project)`,
    );
    expect(g(dir, ["state"], h).code).toBe(EXIT.OK);
    expect(g(dir, ["check"], h).code).toBe(EXIT.OK);
    const lint = g(dir, ["flow", "lint"], h);
    expect(lint.code).toBe(EXIT.OK);
    expect(lint.stdout).toBe("OK tasks\n");
  });

  test("init --global <path> creates .wip/ in <path>", () => {
    const h = home();
    const dir = tmp("g4");
    const out = g(dir, ["init", "--global", "sub"], h);
    expect(out.code).toBe(EXIT.OK);
    expect(existsSync(join(dir, "sub", ".wip"))).toBe(true);
    expect(existsSync(join(dir, ".wip"))).toBe(false);
    expect(tree(join(h, ".claude"))).toEqual(sortedTemplates());
  });

  test("a second project finds the definitions: exists, unchanged, its own onboarding", () => {
    const { h, b } = twoProjects();
    const keys = Object.keys(TEMPLATES);
    const before = tree(h);
    const times = keys.map((k) => statSync(join(h, ".claude", k)).mtimeMs);
    const out = g(b, ["init", "--global"], h);
    expect(out.code).toBe(EXIT.OK);
    for (const key of keys) expect(out.stdout).toContain(`exists ${h}/.claude/${key}`);
    expect(tree(h)).toEqual(before);
    expect(keys.map((k) => statSync(join(h, ".claude", k)).mtimeMs)).toEqual(times);
    expect(existsSync(join(b, ".wip"))).toBe(true);
    expect(out.stdout).toContain("seeded item onboarding");
  });

  test("a second run in the same project changes nothing", () => {
    const { h, a } = twoProjects();
    const beforeDir = tree(a);
    const beforeHome = tree(h);
    const out = g(a, ["init", "--global"], h);
    expect(out.code).toBe(EXIT.OK);
    for (const key of Object.keys(TEMPLATES))
      expect(out.stdout).toContain(`exists ${h}/.claude/${key}`);
    expect(tree(a)).toEqual(beforeDir);
    expect(tree(h)).toEqual(beforeHome);
  });

  test("--force rewrites a changed global template, keeps model: and backs up in the project", () => {
    const { h, a } = twoProjects();
    const fast = join(h, ".claude", "agents", "fast.md");
    const edited = `${readFileSync(fast, "utf8").replace(/^(description:.*)$/m, "$1\nmodel: haiku")}\nExtra.\n`;
    writeFileSync(fast, edited);
    const out = gj(a, ["init", "--global", "--force"], h);
    expect(out.code).toBe(EXIT.OK);
    const file = initFiles(out).find((f) => f.path === `${h}/.claude/agents/fast.md`);
    expect(file?.action).toBe("replaced");
    expect(file?.backup).toMatch(/^\.wip\/backups\/defs\/agents\/fast\.md\./);
    const text = readFileSync(fast, "utf8");
    expect(text).toContain("model: haiku");
    expect(text).not.toContain("Extra.");
    expect(readFileSync(join(a, file?.backup as string), "utf8")).toBe(edited);
    expect(existsSync(join(h, ".wip"))).toBe(false);
    expect(Object.keys(tree(h)).some((k) => k.includes("backup"))).toBe(false);
  });

  test("a global file without the wip: mark is exit 3 and nothing written, also with --force", () => {
    const h = home();
    const dir = tmp("g8");
    mkdirSync(join(h, ".claude", "agents"), { recursive: true });
    writeFileSync(join(h, ".claude", "agents", "fast.md"), "# mine\n");
    const before = tree(h);
    for (const argv of [
      ["init", "--global"],
      ["init", "--global", "--force"],
    ]) {
      const out = g(dir, argv, h);
      expect(out.code).toBe(EXIT.REJECTED);
      expect(out.stderr).toContain(`${h}/.claude/agents/fast.md`);
      expect(tree(h)).toEqual(before);
      expect(existsSync(join(dir, ".wip"))).toBe(false);
    }
  });

  test("other files in $HOME/.claude stay as they were", () => {
    const h = home();
    const dir = tmp("g9");
    mkdirSync(join(h, ".claude", "agents"), { recursive: true });
    mkdirSync(join(h, ".claude", "skills", "other"), { recursive: true });
    writeFileSync(join(h, ".claude", "agents", "mine.md"), "mine\n");
    writeFileSync(join(h, ".claude", "skills", "other", "SKILL.md"), "other\n");
    const args = ["init", "--global", "--force"];
    expect(g(dir, args, h).code).toBe(EXIT.OK);
    expect(readFileSync(join(h, ".claude", "agents", "mine.md"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(h, ".claude", "skills", "other", "SKILL.md"), "utf8")).toBe("other\n");
  });

  test("a project keeps its folder between local and --global", () => {
    const h = home();
    const local = tmp("g10l");
    expect(g(local, ["init"], h).code).toBe(EXIT.OK);
    const beforeLocal = tree(local);
    const beforeHome = tree(h);
    const toGlobal = g(local, ["init", "--global"], h);
    expect(toGlobal.code).toBe(EXIT.REJECTED);
    expect(toGlobal.stderr).toContain("keeps its definitions in .claude/");
    expect(toGlobal.stderr).toContain("run `wip init`");
    expect(tree(local)).toEqual(beforeLocal);
    expect(tree(h)).toEqual(beforeHome);

    const global = tmp("g10g");
    expect(g(global, ["init", "--global"], h).code).toBe(EXIT.OK);
    const beforeGlobal = tree(global);
    const afterGlobal = tree(h);
    const out = g(global, ["init"], h);
    expect(out.code).toBe(EXIT.REJECTED);
    expect(out.stderr).toContain(`keeps its definitions in ${h}/.claude/`);
    expect(out.stderr).toContain("run `wip init --global`");
    expect(tree(global)).toEqual(beforeGlobal);
    expect(tree(h)).toEqual(afterGlobal);

    expect(g(local, ["init", "--global", "--force"], h).code).toBe(EXIT.REJECTED);
    expect(g(global, ["init", "--force"], h).code).toBe(EXIT.REJECTED);
    expect(tree(local)).toEqual(beforeLocal);
    expect(tree(global)).toEqual(beforeGlobal);
  });

  test("--global --force migrates a legacy ~/.agents to ~/.claude and leaves ~/.agents as it is", () => {
    const h = home();
    const dir = tmp("g12");
    mkdirSync(join(dir, ".wip"), { recursive: true });
    writeFileSync(
      join(dir, ".wip", "config.json"),
      `${JSON.stringify({ defs_dir: "~/.agents" })}\n`,
    );
    for (const [key, text] of Object.entries(TEMPLATES)) {
      const file = join(h, ".agents", key);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    const agentsBefore = tree(join(h, ".agents"));
    const out = gj(dir, ["init", "--global", "--force"], h);
    expect(out.code).toBe(EXIT.OK);
    expect(out.body.data).toMatchObject({ defs_dir: "~/.claude", switched_from: "~/.agents" });
    expect(tree(join(h, ".claude"))).toEqual(sortedTemplates());
    expect(tree(join(h, ".agents"))).toEqual(agentsBefore);
    expect(config(dir)).toEqual({ defs_dir: "~/.claude" });
    expect(existsSync(join(dir, ".claude"))).toBe(false);
    expect(existsSync(join(dir, ".agents"))).toBe(false);
  });

  test("a global project ignores the repo's .agents/", () => {
    const h = home();
    const dir = tmp("g11");
    expect(g(dir, ["init", "--global"], h).code).toBe(EXIT.OK);
    const zzz = join(dir, ".agents", "skills", "wip-flow-zzz");
    mkdirSync(zzz, { recursive: true });
    writeFileSync(join(zzz, "SKILL.md"), flowSkill("zzz"));
    const lint = g(dir, ["flow", "lint"], h);
    expect(lint.stdout).toBe("OK tasks\n");
    expect(lint.stdout).not.toContain("zzz");
  });

  test("a flow in $HOME/.claude is valid in every global project", () => {
    const { h, a, b } = twoProjects();
    expect(g(b, ["init", "--global"], h).code).toBe(EXIT.OK);
    const x = join(h, ".claude", "skills", "wip-flow-x");
    mkdirSync(x, { recursive: true });
    writeFileSync(join(x, "SKILL.md"), flowSkill("x"));
    for (const dir of [a, b]) {
      expect(g(dir, ["flow", "lint", "x"], h).code).toBe(EXIT.OK);
      expect(g(dir, ["phase", "X1", "todo", "--flow", "x"], h).code).toBe(EXIT.OK);
    }
  });

  test("the stored path and the warnings show ~/ when the global flow file is gone", () => {
    const { h, a } = twoProjects();
    rmSync(join(h, ".claude", "skills", "wip-flow-tasks"), { recursive: true });
    const gone = gj(a, ["check"], h);
    const text = gone.body.warnings.map((w) => w.message).join("\n");
    expect(text).toContain("flow tasks has no file at ~/.claude/skills/wip-flow-tasks/SKILL.md");
  });

  test("a broken global agent is reported with its ~/ path", () => {
    const { h, a } = twoProjects();
    writeFileSync(join(h, ".claude", "agents", "fast.md"), "---\nwip: generic\n---\nno name\n");
    const out = gj(a, ["check"], h);
    const finding = JSON.stringify(out.body);
    expect(finding).toContain("agent_invalid");
    expect(finding).toContain("~/.claude/agents/fast.md");
  });

  test("--json keeps ~/ in defs_dir and gives the file paths under $HOME", () => {
    const h = home();
    const dir = tmp("g14");
    const out = gj(dir, ["init", "--global"], h);
    expect(out.code).toBe(EXIT.OK);
    expect(out.body.data?.defs_dir).toBe("~/.claude");
    const files = initFiles(out);
    expect(files.length).toBe(Object.keys(TEMPLATES).length);
    for (const f of files) expect(f.path.startsWith(`${h}/.claude/`)).toBe(true);
  });

  test("--global takes no value", () => {
    const h = home();
    const dir = tmp("g15");
    expect(g(dir, ["init", "--global", "a", "b"], h).code).toBe(EXIT.USAGE);
    const eq = g(dir, ["init", "--global=x"], h);
    expect(eq.code).toBe(EXIT.USAGE);
    expect(eq.stderr).toContain("takes no value");
    expect(existsSync(join(dir, ".wip"))).toBe(false);
  });

  test("without HOME, --global is exit 3 and writes nothing", () => {
    const dir = tmp("g-nohome");
    const out = wipIn(dir, ["init", "--global"], NO_ENV);
    expect(out.code).toBe(EXIT.REJECTED);
    expect(out.stderr).toContain("HOME");
    expect(existsSync(join(dir, ".wip"))).toBe(false);
  });
});

describe("wip init --gitignore and wip_bin", () => {
  const read = (dir: string) => readFileSync(join(dir, ".gitignore"), "utf8");

  test("--gitignore none creates no .gitignore", () => {
    const dir = tmp("gi-none");
    const out = wipIn(dir, ["init", "--gitignore", "none"]);
    expect(out.code).toBe(EXIT.OK);
    expect(out.stdout).toContain("skipped .gitignore");
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  });

  test("bad values are usage errors and write nothing", () => {
    for (const v of ["x", "none,wip", "wip,", ""]) {
      const dir = tmp("gi-bad");
      expect(wipIn(dir, ["init", "--gitignore", v]).code).toBe(EXIT.USAGE);
      expect(existsSync(join(dir, ".wip"))).toBe(false);
    }
  });

  test("wip,defs writes exact template paths once, also with --force", () => {
    const dir = tmp("gi-defs");
    writeFileSync(join(dir, ".gitignore"), "dist");
    const first = wipIn(dir, ["init", "--gitignore", "wip,defs"]);
    expect(first.code).toBe(EXIT.OK);
    const text = read(dir);
    expect(text.startsWith("dist\n.wip/\n# wip definitions\n")).toBe(true);
    expect(text).toContain(".claude/agents/wip.md\n");
    expect(text).toContain(".claude/skills/wip-coordinate/\n");
    expect(text).not.toContain(".claude/\n");
    expect(text).not.toContain("SKILL.md");
    expect(wipIn(dir, ["init", "--force", "--gitignore", "wip,defs"]).code).toBe(EXIT.OK);
    expect(read(dir)).toBe(text);
  });

  test("defs with --global warns and writes nothing for defs", () => {
    const dir = tmp("gi-global");
    const home = scratch("init-gi-home");
    dirs.push(home);
    const out = wipIn(dir, ["init", "--global", "--gitignore", "wip,defs"], { HOME: home });
    expect(out.code).toBe(EXIT.OK);
    expect(out.stderr).toContain("--gitignore defs ignored");
    expect(read(dir)).toBe(".wip/\n");
  });

  test("CRLF files keep their line ending", () => {
    const dir = tmp("gi-crlf");
    writeFileSync(join(dir, ".gitignore"), "dist\r\n");
    wipIn(dir, ["init"]);
    expect(read(dir)).toBe("dist\r\n.wip/\r\n");
  });

  test("wip_bin is recorded from WIP_LAUNCH_BIN and kept when none is given", () => {
    const dir = tmp("bin");
    const out = wipIn(dir, ["init", "--yes"], { WIP_LAUNCH_BIN: "/opt/x/wip" });
    expect(out.stdout).toContain("wip_bin set to /opt/x/wip");
    const cfg = () => JSON.parse(readFileSync(join(dir, ".wip", "config.json"), "utf8"));
    expect(cfg().wip_bin).toBe("/opt/x/wip");
    const next = wipIn(dir, ["init", "--yes"], { WIP_LAUNCH_BIN: "/opt/y/wip" });
    expect(next.stdout).toContain("wip_bin changed from /opt/x/wip to /opt/y/wip");
    if (WIP_BIN === null) {
      wipIn(dir, ["init", "--yes"]);
      expect(cfg().wip_bin).toBe("/opt/y/wip");
    }
  });
});

describe("wip init and the Kanban mod (F-NEW-08)", () => {
  const MOD = ".claude/skills/wip-kanban";
  const ID = "wip-kanban@skills-dir";

  // biome-ignore lint/suspicious/noExplicitAny: the init data of the API under test
  const kanban = (out: IEnvelopeOut): any => out.body.data?.kanban;
  const settingsText = (dir: string, name: string): string =>
    readFileSync(join(dir, ".claude", name), "utf8");
  const modText = (dir: string, key: string): string => readFileSync(join(dir, MOD, key), "utf8");

  test("--yes installs neither copy nor settings; --kanban installs both in .claude/settings.json", () => {
    const plain = tmp("k-plain");
    const out = wipJsonIn(plain, ["init", "--yes"]);
    expect(out.code).toBe(EXIT.OK);
    expect(existsSync(join(plain, MOD))).toBe(false);
    expect(existsSync(join(plain, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(plain, ".claude", "settings.local.json"))).toBe(false);
    expect(kanban(out)).toEqual({
      requested: false,
      installed: false,
      path: null,
      id: null,
      copy: null,
      settings: null,
    });

    const dir = tmp("k-install");
    const withMod = wipJsonIn(dir, ["init", "--yes", "--kanban"]);
    expect(withMod.code).toBe(EXIT.OK);
    expect(tree(join(dir, MOD))).toEqual(
      Object.fromEntries(
        Object.entries(KANBAN_MOD)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, text]) => [key, text]),
      ),
    );
    expect(modText(dir, ".claude-plugin/wip.json")).toBe(
      '{\n  "format": 1,\n  "owner": "@garndev/wip",\n  "plugin": "wip-kanban"\n}\n',
    );
    expect(JSON.parse(settingsText(dir, "settings.json"))).toEqual({
      $schema: "https://json.schemastore.org/claude-code-settings.json",
      enabledPlugins: { [ID]: true },
    });
    expect(existsSync(join(dir, ".claude", "settings.local.json"))).toBe(false);
    expect(kanban(withMod)).toMatchObject({
      requested: true,
      installed: true,
      path: MOD,
      id: ID,
      copy: { action: "created", backup: null, removed: [] },
      settings: {
        path: ".claude/settings.json",
        scope: "project",
        action: "created",
        backup: null,
      },
    });
    expect(withMod.body.warnings.map((w) => w.code)).toEqual([]);
  });

  test("--kanban-settings-file settings.local.json writes only the local file", () => {
    const dir = tmp("k-local");
    const out = wipJsonIn(dir, [
      "init",
      "--yes",
      "--kanban",
      "--kanban-settings-file",
      "settings.local.json",
    ]);
    expect(out.code).toBe(EXIT.OK);
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(false);
    expect(JSON.parse(settingsText(dir, "settings.local.json")).enabledPlugins).toEqual({
      [ID]: true,
    });
    expect(kanban(out).settings).toMatchObject({
      path: ".claude/settings.local.json",
      scope: "local",
      action: "created",
    });
    expect(
      wipIn(dir, ["init", "--yes", "--kanban", "--kanban-settings-file", "settings.local.json"])
        .stdout,
    ).toContain("--scope local");
  });

  test("a second run says exists and changes no bytes; a normal init leaves a copy and settings alone", () => {
    const dir = tmp("k-twice");
    expect(wipJsonIn(dir, ["init", "--yes", "--kanban"]).code).toBe(EXIT.OK);
    const before = tree(dir);
    const out = wipJsonIn(dir, ["init", "--yes", "--kanban"]);
    expect(out.code).toBe(EXIT.OK);
    expect(tree(dir)).toEqual(before);
    expect(kanban(out).copy).toEqual({ action: "exists", backup: null, removed: [] });
    expect(kanban(out).settings).toEqual({
      path: ".claude/settings.json",
      scope: "project",
      action: "exists",
      backup: null,
    });

    const plain = wipJsonIn(dir, ["init", "--yes"]);
    expect(plain.code).toBe(EXIT.OK);
    expect(tree(dir)).toEqual(before);
    expect(kanban(plain)).toMatchObject({
      requested: false,
      installed: true,
      copy: null,
      settings: null,
    });
  });

  test("--kanban merges the chosen file, preserving keys, order and other plugins, with a backup", () => {
    const dir = tmp("k-merge");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const before = `{
  "permissions": { "allow": ["Bash(wip:*)"] },
  "enabledPlugins": { "other@market": true },
  "env": { "A": "1" }
}
`;
    writeFileSync(join(dir, ".claude", "settings.json"), before);
    const out = wipJsonIn(dir, ["init", "--yes", "--kanban"]);
    expect(out.code).toBe(EXIT.OK);
    const after = JSON.parse(settingsText(dir, "settings.json"));
    expect(after).toEqual({
      permissions: { allow: ["Bash(wip:*)"] },
      enabledPlugins: { "other@market": true, [ID]: true },
      env: { A: "1" },
    });
    expect(Object.keys(after)).toEqual(["permissions", "enabledPlugins", "env"]);
    const backup = kanban(out).settings.backup as string;
    expect(backup).toStartWith(".wip/backups/claude-settings/settings.json.");
    expect(readFileSync(join(dir, backup), "utf8")).toBe(before);
  });

  test("--force replaces the folder, backs the old one up, removes extras and keeps the generated types", () => {
    const dir = tmp("k-force");
    expect(wipJsonIn(dir, ["init", "--yes", "--kanban"]).code).toBe(EXIT.OK);
    writeFileSync(join(dir, MOD, "README.md"), "edited");
    writeFileSync(join(dir, MOD, "notas.txt"), "mine");
    mkdirSync(join(dir, MOD, ".claude-plugin", "types"), { recursive: true });
    writeFileSync(join(dir, MOD, ".claude-plugin", "types", "index.d.ts"), "generated");

    const out = wipJsonIn(dir, ["init", "--yes", "--kanban", "--force"]);
    expect(out.code).toBe(EXIT.OK);
    expect(modText(dir, "README.md")).toBe(KANBAN_MOD["README.md"] as string);
    expect(existsSync(join(dir, MOD, "notas.txt"))).toBe(false);
    expect(readFileSync(join(dir, MOD, ".claude-plugin", "types", "index.d.ts"), "utf8")).toBe(
      "generated",
    );
    const copy = kanban(out).copy;
    expect(copy.action).toBe("replaced");
    expect(copy.removed).toEqual([`${MOD}/notas.txt`]);
    expect(readFileSync(join(dir, copy.backup, "notas.txt"), "utf8")).toBe("mine");
    expect(readFileSync(join(dir, copy.backup, "README.md"), "utf8")).toBe("edited");

    const again = wipJsonIn(dir, ["init", "--yes", "--kanban", "--force"]);
    expect(again.code).toBe(EXIT.OK);
    expect(kanban(again).copy).toEqual({
      action: "exists",
      backup: null,
      removed: [],
    });
    expect(readdirSync(join(dir, ".wip", "backups", "kanban"))).toHaveLength(1);

    // The removed file is listed on the output, one line each.
    writeFileSync(join(dir, MOD, "otra.txt"), "mine");
    const text = wipIn(dir, ["init", "--yes", "--kanban", "--force"]);
    expect(text.code).toBe(EXIT.OK);
    expect(text.stdout).toContain(`removed ${MOD}/otra.txt`);
  });

  test("a foreign folder, a file or a symlink at the mod path exits 3 and writes nothing", () => {
    const foreign = tmp("k-foreign");
    mkdirSync(join(foreign, MOD, ".claude-plugin"), { recursive: true });
    writeFileSync(join(foreign, MOD, ".claude-plugin", "wip.json"), '{"owner": "someone"}');
    const beforeForeign = tree(foreign);
    for (const argv of [
      ["init", "--yes", "--kanban"],
      ["init", "--yes", "--kanban", "--force"],
    ]) {
      const out = wipJsonIn(foreign, argv);
      expect(out.code).toBe(EXIT.REJECTED);
      expect(out.body.message).toContain("not wip's");
      expect(tree(foreign)).toEqual(beforeForeign);
    }
    // Without --kanban the folder is another plugin's and is left alone.
    const modBefore = tree(join(foreign, MOD));
    expect(wipJsonIn(foreign, ["init", "--yes"]).code).toBe(EXIT.OK);
    expect(tree(join(foreign, MOD))).toEqual(modBefore);
    expect(existsSync(join(foreign, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(foreign, ".claude", "settings.local.json"))).toBe(false);

    const file = tmp("k-file");
    mkdirSync(join(file, ".claude", "skills"), { recursive: true });
    writeFileSync(join(file, MOD), "not a folder");
    const beforeFile = tree(file);
    const out = wipJsonIn(file, ["init", "--yes", "--kanban", "--force"]);
    expect(out.code).toBe(EXIT.REJECTED);
    expect(tree(file)).toEqual(beforeFile);

    const link = tmp("k-link");
    mkdirSync(join(link, ".claude", "skills"), { recursive: true });
    mkdirSync(join(link, "elsewhere"));
    symlinkSync(join(link, "elsewhere"), join(link, MOD));
    const beforeLink = tree(link);
    expect(wipJsonIn(link, ["init", "--yes", "--kanban", "--force"]).code).toBe(EXIT.REJECTED);
    expect(tree(link)).toEqual(beforeLink);
  });

  test("--kanban-settings-file without --kanban or with another value is exit 2, writing nothing", () => {
    for (const argv of [
      ["init", "--yes", "--kanban-settings-file", "settings.local.json"],
      ["init", "--yes", "--kanban", "--kanban-settings-file", "other.json"],
      ["init", "--yes", "--kanban-settings-file", ""],
      ["init", "--yes", "--kanban=local"],
    ]) {
      const dir = tmp("k-usage");
      const out = wipIn(dir, argv);
      expect({ argv, code: out.code }).toEqual({ argv, code: EXIT.USAGE });
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  test("an invalid chosen settings file exits 3 and writes neither the copy nor .wip/", () => {
    const dir = tmp("k-invalid");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), "{oops");
    const before = tree(dir);
    const out = wipJsonIn(dir, ["init", "--yes", "--kanban"]);
    expect(out.code).toBe(EXIT.REJECTED);
    expect(out.body.message).toContain(".claude/settings.json");
    expect(tree(dir)).toEqual(before);
    expect(existsSync(join(dir, ".wip"))).toBe(false);
    expect(existsSync(join(dir, MOD))).toBe(false);
  });

  test("a false local entry overrides the project one: a warning, and the local file is not edited", () => {
    const dir = tmp("k-overridden");
    expect(wipJsonIn(dir, ["init", "--yes", "--kanban"]).code).toBe(EXIT.OK);
    writeFileSync(
      join(dir, ".claude", "settings.local.json"),
      `${JSON.stringify({ enabledPlugins: { [ID]: false } })}\n`,
    );
    const localBefore = settingsText(dir, "settings.local.json");
    const out = wipJsonIn(dir, ["init", "--yes", "--kanban"]);
    expect(out.code).toBe(EXIT.OK);
    expect(out.body.warnings.map((w) => w.code)).toEqual(["kanban_settings_overridden"]);
    expect(out.body.warnings[0]?.message).toContain(".claude/settings.local.json");
    expect(settingsText(dir, "settings.local.json")).toBe(localBefore);
    expect(JSON.parse(settingsText(dir, "settings.json")).enabledPlugins[ID]).toBe(true);
  });

  test("a project false with a local true is a duplicate; the project file is not edited", () => {
    const dir = tmp("k-duplicate");
    expect(wipJsonIn(dir, ["init", "--yes", "--kanban"]).code).toBe(EXIT.OK);
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      `${JSON.stringify({ enabledPlugins: { [ID]: false } })}\n`,
    );
    const projectBefore = settingsText(dir, "settings.json");
    const out = wipJsonIn(dir, [
      "init",
      "--yes",
      "--kanban",
      "--kanban-settings-file",
      "settings.local.json",
    ]);
    expect(out.code).toBe(EXIT.OK);
    expect(out.body.warnings.map((w) => w.code)).toEqual(["kanban_settings_duplicate"]);
    expect(out.body.warnings[0]?.message).toContain(".claude/settings.json");
    expect(settingsText(dir, "settings.json")).toBe(projectBefore);
    expect(JSON.parse(settingsText(dir, "settings.local.json")).enabledPlugins[ID]).toBe(true);
  });

  test("--force does not reactivate a false entry; --kanban writes true with a backup", () => {
    const dir = tmp("k-false");
    expect(wipJsonIn(dir, ["init", "--yes", "--kanban"]).code).toBe(EXIT.OK);
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      `${JSON.stringify({ enabledPlugins: { [ID]: false } })}\n`,
    );
    const falseText = settingsText(dir, "settings.json");

    const forced = wipJsonIn(dir, ["init", "--yes", "--force"]);
    expect(forced.code).toBe(EXIT.OK);
    expect(settingsText(dir, "settings.json")).toBe(falseText);
    expect(kanban(forced)).toMatchObject({ requested: false, settings: null });

    const again = wipJsonIn(dir, ["init", "--yes", "--kanban"]);
    expect(again.code).toBe(EXIT.OK);
    expect(JSON.parse(settingsText(dir, "settings.json")).enabledPlugins[ID]).toBe(true);
    expect(kanban(again).settings.action).toBe("updated");
    expect(kanban(again).settings.backup).toStartWith(
      ".wip/backups/claude-settings/settings.json.",
    );
  });

  test("a normal init leaves an existing settings file byte-identical", () => {
    const dir = tmp("k-untouched");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), "{}\n");
    expect(wipIn(dir, ["init", "--yes"]).code).toBe(EXIT.OK);
    expect(settingsText(dir, "settings.json")).toBe("{}\n");
    expect(existsSync(join(dir, ".claude", "settings.local.json"))).toBe(false);
  });
});
