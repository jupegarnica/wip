import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../../src/cli.ts";
import { isInitPrompt, promptInit, unsetLine } from "../../src/commands/init.ts";
import { joinCommand, splitCommand } from "../../src/init/command.ts";
import {
  type IAsker,
  type ISelectOption,
  inputStep,
  keysOf,
  optionsError,
  redraw,
  renderSelect,
  resolveOption,
  screenRows,
  selectStep,
} from "../../src/init/prompt.ts";
import { box, makeStyle, PLAIN, visibleLength } from "../../src/init/style.ts";
import { scratch } from "../helpers/project.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = scratch("init-prompt");
  dirs.push(d);
  return d;
}

/**
 * Answers in order: `""` takes the default (the highlighted option), `null` is Ctrl+C. A select answer is typed text,
 * checked like the terminal does; a bad one is asked again from the queue.
 */
function fake(answers: (string | null)[]): IAsker & { said: string[]; asked: string[] } {
  const queue = [...answers];
  const said: string[] = [];
  const asked: string[] = [];
  const next = () => (queue.length === 0 ? null : (queue.shift() as string | null));
  return {
    said,
    asked,
    style: PLAIN,
    select: async (spec) => {
      asked.push(
        `${spec.question} [${spec.options.map((o) => o.value).join("|")}] @${spec.initial}`,
      );
      for (;;) {
        const a = next();
        if (a === null) return null;
        if (a === "") return (spec.options[spec.initial] as ISelectOption).value;
        const i = resolveOption(a, spec.options);
        if (i >= 0) return (spec.options[i] as ISelectOption).value;
        said.push(optionsError(spec.options));
      }
    },
    input: async (spec) => {
      asked.push(`${spec.label} [${spec.show ?? spec.def ?? ""}]`);
      const a = next();
      return a === null ? null : a.trim() === "" ? (spec.def ?? "") : a.trim();
    },
    say: (l) => {
      said.push(l);
    },
    close: () => {},
  };
}

function wip(dir: string, argv: string[]) {
  return run(argv, { cwd: dir, env: {} });
}

function modelOf(dir: string, name: string, defs = ".claude"): string | null {
  const text = readFileSync(join(dir, defs, "agents", `${name}.md`), "utf8");
  return text.match(/^model: (.*)$/m)?.[1] ?? null;
}

const CLAUDE_DEFAULT_START = ["claude", "--agent", "wip", "--name", "wip-{stamp}"];

function config(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, ".wip", "config.json"), "utf8"));
}

describe("helpers", () => {
  test("splitCommand and joinCommand", () => {
    expect(splitCommand(`claude --agent wip --name "a b" 'c d'`)).toEqual([
      "claude",
      "--agent",
      "wip",
      "--name",
      "a b",
      "c d",
    ]);
    expect(() => splitCommand(`a "b`)).toThrow();
    expect(splitCommand(joinCommand(["x", "a b", "c"]))).toEqual(["x", "a b", "c"]);
  });
  test("isInitPrompt needs a terminal and no --yes / --json / --help", () => {
    expect(isInitPrompt(["init"], true)).toBe(true);
    expect(isInitPrompt(["init"], false)).toBe(false);
    expect(isInitPrompt(["init", "--yes"], true)).toBe(false);
    expect(isInitPrompt(["init", "--json"], true)).toBe(false);
    expect(isInitPrompt(["init", "--help"], true)).toBe(false);
    expect(isInitPrompt(["phase"], true)).toBe(false);
  });
  test("unsetLine", () => {
    expect(unsetLine([], false)).toBeNull();
    expect(unsetLine(["fast"], true)).toContain("no model for fast; no start command");
  });
});

const OPTIONS: ISelectOption[] = [
  { value: "alpha", label: "alpha" },
  { value: "beta", label: "beta" },
];

describe("select and input keys", () => {
  const st = { cursor: 0, buffer: "", error: null };
  test("resolveOption takes a number, a value or a label, and nothing else", () => {
    expect(resolveOption("1", OPTIONS)).toBe(0);
    expect(resolveOption("2", OPTIONS)).toBe(1);
    expect(resolveOption("beta", OPTIONS)).toBe(1);
    expect(resolveOption("ALPHA", OPTIONS)).toBe(0);
    for (const bad of ["", "0", "3", "none", "claude-code"])
      expect(resolveOption(bad, OPTIONS)).toBe(-1);
  });
  test("arrows move and wrap; Enter confirms the highlighted option", () => {
    const down = selectStep(st, "\x1b[B", OPTIONS);
    expect(down).toEqual({ state: { cursor: 1, buffer: "", error: null } });
    expect(selectStep({ ...st, cursor: 1 }, "\x1b[B", OPTIONS)).toEqual({ state: st });
    expect(selectStep(st, "\x1b[A", OPTIONS)).toEqual({
      state: { cursor: 1, buffer: "", error: null },
    });
    expect(selectStep({ ...st, cursor: 1 }, "\r", OPTIONS)).toEqual({ done: 1 });
  });
  test("typing 2 highlights beta; Enter confirms; typed beta works; junk is refused", () => {
    const two = selectStep(st, "2", OPTIONS) as { state: typeof st };
    expect(two.state.cursor).toBe(1);
    expect(selectStep(two.state, "\r", OPTIONS)).toEqual({ done: 1 });
    let cur = st;
    for (const c of "beta") cur = (selectStep(cur, c, OPTIONS) as { state: typeof st }).state;
    expect(selectStep(cur, "\r", OPTIONS)).toEqual({ done: 1 });
    const none = (selectStep(st, "n", OPTIONS) as { state: typeof st }).state;
    const refused = selectStep(none, "\r", OPTIONS) as { state: typeof st };
    expect(refused.state.error ?? "").toContain("not an option");
    expect(refused.state.buffer).toBe("");
  });
  test("Ctrl+C and Ctrl+D abort; input edits and confirms", () => {
    expect(selectStep(st, "\x03", OPTIONS)).toEqual({ abort: true });
    expect(inputStep("ab", "\x03")).toEqual({ abort: true });
    expect(inputStep("", "\x04")).toEqual({ abort: true });
    expect(inputStep("ab", "c")).toEqual({ state: "abc" });
    expect(inputStep("abc", "\x7f")).toEqual({ state: "ab" });
    expect(inputStep("ab", "\x1b[A")).toEqual({ state: "ab" });
    expect(inputStep("ab", "\r")).toEqual({ done: "ab" });
    expect(keysOf("2\r\x1b[B")).toEqual(["2", "\r", "\x1b[B"]);
  });
  test("render marks the selected option; colour only when asked", () => {
    const spec = { question: "Where?", options: OPTIONS, initial: 1 };
    const plain = renderSelect(spec, { cursor: 1, buffer: "", error: null }, PLAIN).join("\n");
    expect(plain).toContain("❯ 2) beta");
    expect(plain).not.toContain("\x1b");
    const color = renderSelect(spec, { cursor: 1, buffer: "", error: null }, makeStyle(true));
    expect(color.join("\n")).toContain("\x1b[");
    const lines = box("Summary", ["a", "bcd"], PLAIN);
    expect(new Set(lines.map(visibleLength)).size).toBe(1);
  });
  test("a redraw goes up the rows the wrapped lines took, not the line count", () => {
    const hint = "h".repeat(150);
    const spec = {
      question: "Where?",
      options: [OPTIONS[0] as ISelectOption, { ...OPTIONS[1], hint } as ISelectOption],
      initial: 0,
    };
    const drawn = renderSelect(spec, { cursor: 0, buffer: "", error: null }, makeStyle(true));
    expect(drawn.length).toBe(4);
    expect(screenRows(drawn, 80)).toBe(6);
    expect(screenRows(drawn, 200)).toBe(4);
    expect(screenRows(drawn, undefined)).toBe(4);
    expect(screenRows(["x".repeat(80)], 80)).toBe(1);
    expect(screenRows([""], 80)).toBe(1);
    expect(redraw(0, ["a", "b"])).toBe("\r\x1b[Ja\nb\n");
    expect(redraw(6, ["a"])).toBe("\x1b[6A\r\x1b[Ja\n");
  });
});

describe("promptInit", () => {
  const env = { PATH: "" };

  test("the first question is scope; Enter keeps local and adds no --global", async () => {
    const dir = tmp();
    const asker = fake(["", "", "", "", "", "", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect(asker.asked[0]).toBe("Where do the agents and skills live? [local|global] @0");
    expect(asker.said.join("\n")).toContain("1/4 Scope");
    expect(asker.said.join("\n")).toMatch(/scope\s+local/);
    expect(out.argv).not.toContain("--global");
  });

  test("the wizard asks no model and init writes the templates' models", async () => {
    const dir = tmp();
    // scope, start, .wip/, defs, Kanban (no), Write
    const asker = fake(["", "", "", "", "no", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect(asker.asked.join("\n")).not.toContain("Model of");
    expect(out.argv).not.toContain("--models");
    const res = wip(dir, out.argv as string[]);
    expect(res.code).toBe(0);
    expect(["haiku", "sonnet", "opus", "fable", "inherit"] as (string | null)[]).toEqual(
      ["fast", "efficient", "thinker", "wise", "wip"].map((a) => modelOf(dir, a)),
    );
    expect(res.stdout).not.toContain("Still unset");
  });

  test("Enter takes every default and the default start; no in Kanban keeps argv to those", async () => {
    const dir = tmp();
    // scope, start, .wip/, defs, Kanban (no), Write.
    const asker = fake(["", "", "", "", "no", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect(asker.asked.join("\n")).not.toContain("Model of");
    expect(out.argv).toEqual([
      "init",
      "--start",
      "claude --agent wip --name wip-{stamp}",
      "--gitignore",
      "wip",
    ]);
  });

  test("a bad start command asks again", async () => {
    const dir = tmp();
    const asker = fake(["", "claude {nope}", "claude --agent wip", "", "", "no", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect(asker.said.join("\n")).toContain("unknown variable {nope}");
    expect(out.argv).toContain("claude --agent wip");
  });

  test("an existing agent's model line is left alone and never asked about", async () => {
    const dir = tmp();
    expect(wip(dir, ["init", "--yes"]).code).toBe(0);
    const file = join(dir, ".claude", "agents", "thinker.md");
    writeFileSync(file, readFileSync(file, "utf8").replace(/^model: .*$/m, "model: sonnet"));
    // start, defs, Kanban (no), Write.
    const asker = fake(["", "", "no", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect(asker.asked.join("\n")).not.toContain("Model of");
    expect((out.argv as string[]).join(" ")).not.toContain("--models");
    expect(modelOf(dir, "thinker")).toBe("sonnet");
  });

  test("answer global adds --global and the summary shows the folder under HOME", async () => {
    for (const pick of ["2", "global"]) {
      const dir = tmp();
      const home = tmp();
      // scope (global), start, .wip/, Kanban, file, Write.
      const asker = fake([pick, "", "", "", "", ""]);
      const out = await promptInit(["init"], dir, { PATH: "", HOME: home }, asker);
      expect(out.argv?.[1]).toBe("--global");
      const said = asker.said.join("\n");
      expect(said).toMatch(/scope\s+global/);
      const defsRow = asker.said.find((line) => /\bdefs\s/.test(line));
      expect(defsRow).toContain(`${join(home, ".claude")}/`);
      expect(said).toContain(`live in ${join(home, ".claude")}/`);
      expect(said).not.toContain("~/.agents/");
    }
  });

  test("--global skips the scope question and is not duplicated", async () => {
    const dir = tmp();
    const home = tmp();
    // start, .wip/, Kanban, file, Write.
    const asker = fake(["", "", "", "", ""]);
    const out = await promptInit(["init", "--global"], dir, { PATH: "", HOME: home }, asker);
    expect(asker.asked.join("\n")).not.toContain("Where do the agents and skills live");
    expect(asker.said.join("\n")).toContain("from --global");
    expect((out.argv as string[]).filter((a) => a === "--global")).toHaveLength(1);
  });

  test("an initialised project shows scope kept and asks nothing about scope", async () => {
    const dir = tmp();
    expect(wip(dir, ["init", "--yes"]).code).toBe(0);
    // start, defs, Kanban, file, Write.
    const asker = fake(["", "", "", "", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect(asker.asked.join("\n")).not.toContain("Where do the agents and skills live");
    expect(asker.said.join("\n")).toContain("scope kept: local");
    expect(out.argv).not.toContain("--global");

    const dirG = tmp();
    const home = tmp();
    const genv = { PATH: "", HOME: home };
    expect(run(["init", "--yes", "--global"], { cwd: dirG, env: genv }).code).toBe(0);
    // start, .wip/, Kanban, file, Write.
    const askerG = fake(["", "", "", "", ""]);
    const outG = await promptInit(["init"], dirG, genv, askerG);
    expect(askerG.asked.join("\n")).not.toContain("Where do the agents and skills live");
    expect(askerG.said.join("\n")).toContain("scope kept: global");
    expect(outG.argv).toContain("--global");
  });

  test("Ctrl+C aborts with 130 and writes nothing", async () => {
    const dir = tmp();
    const out = await promptInit(["init"], dir, env, fake(["", null]));
    expect(out).toEqual({ argv: null, code: 130 });
    expect(readdirSync(dir)).toEqual([]);
    const first = await promptInit(["init"], dir, env, fake([null]));
    expect(first).toEqual({ argv: null, code: 130 });
  });

  test("the Git step asks .wip/ and the definitions, default yes and no", async () => {
    const dir = tmp();
    // scope, start, .wip/, defs, Kanban (no), Write.
    const asker = fake(["", "", "", "", "no", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect(asker.said.join("\n")).toContain("3/4 Git");
    expect(asker.said.join("\n")).toMatch(/gitignore\s+wip/);
    expect(out.argv?.slice(-2)).toEqual(["--gitignore", "wip"]);
  });

  test("no to .wip/ and yes to defs gives --gitignore defs; both no gives none", async () => {
    const a = fake(["", "", "n", "y", "no", ""]);
    expect((await promptInit(["init"], tmp(), env, a)).argv?.slice(-2)).toEqual([
      "--gitignore",
      "defs",
    ]);
    const b = fake(["", "", "n", "n", "no", ""]);
    expect((await promptInit(["init"], tmp(), env, b)).argv?.slice(-2)).toEqual([
      "--gitignore",
      "none",
    ]);
  });

  test("an already ignored .wip/ is not asked; --gitignore skips the step; global asks no defs", async () => {
    const dir = tmp();
    expect(wip(dir, ["init", "--yes"]).code).toBe(0);
    // start, defs, Kanban, file, Write.
    const a = fake(["", "", "", "", ""]);
    const out = await promptInit(["init"], dir, env, a);
    expect(a.said.join("\n")).toContain(".wip/ already ignored");
    expect(out.argv).not.toContain("--gitignore");

    // scope, start, Kanban, file, Write.
    const b = fake(["", "", "", "", ""]);
    const outB = await promptInit(["init", "--gitignore", "none"], tmp(), env, b);
    expect(b.said.join("\n")).toContain("from --gitignore none");
    expect(b.asked.join("\n")).not.toContain("Ignore .wip/");
    expect(outB.argv?.filter((x) => x === "--gitignore")).toHaveLength(1);

    const home = tmp();
    // start, .wip/, Kanban, file, Write.
    const c = fake(["", "", "", "", ""]);
    await promptInit(["init", "--global"], tmp(), { PATH: "", HOME: home }, c);
    expect(c.asked.join("\n")).not.toContain("Also ignore the wip definitions");
  });

  test("a legacy .agents folder shows the switch note, wip init exits 3 and --force migrates", async () => {
    const dir = tmp();
    expect(wip(dir, ["init", "--yes"]).code).toBe(0);
    mkdirSync(join(dir, ".agents"), { recursive: true });
    writeFileSync(
      join(dir, ".wip", "config.json"),
      `${JSON.stringify({ defs_dir: ".agents" }, null, 2)}\n`,
    );
    // start, defs, Kanban, file, Write.
    const asker = fake(["", "", "", "", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    const said = asker.said.join("\n");
    expect(said).toContain("this project uses .agents/");
    expect(said).toContain("wip now writes .claude/");
    expect(said).toContain("wip init --force");
    expect(said).toMatch(/defs\s+\.claude\/ \(switch from \.agents\/\)/);
    expect(out.argv).not.toContain("--force");
    const res = wip(dir, out.argv as string[]);
    expect(res.code).toBe(3);
    expect(res.stderr).toContain("run with --force to add .claude/");
    const forced = wip(dir, ["init", "--force", "--yes"]);
    expect(forced.code).toBe(0);
    expect(config(dir).defs_dir).toBe(".claude");
  });

  test("a legacy global folder is noted with its absolute path and the .claude target", async () => {
    const dir = tmp();
    const home = tmp();
    const genv = { PATH: "", HOME: home };
    mkdirSync(join(dir, ".wip"), { recursive: true });
    mkdirSync(join(home, ".agents"), { recursive: true });
    writeFileSync(
      join(dir, ".wip", "config.json"),
      `${JSON.stringify({ defs_dir: "~/.agents" }, null, 2)}\n`,
    );
    // start, .wip/, Kanban, file, Write.
    const asker = fake(["", "", "", "", ""]);
    await promptInit(["init"], dir, genv, asker);
    expect(asker.said.join("\n")).toContain(
      `this project uses ${join(home, ".agents")}/; wip now writes ${join(home, ".claude")}/`,
    );
  });

  test("no switch note when the folder is the kept one or there is no config", async () => {
    const dir = tmp();
    expect(wip(dir, ["init", "--yes"]).code).toBe(0);
    // start, defs, Kanban, file, Write.
    const same = fake(["", "", "", "", ""]);
    await promptInit(["init"], dir, env, same);
    expect(same.said.join("\n")).not.toContain("needs `wip init --force`");
    expect(same.said.join("\n")).not.toContain("switch from");

    // scope, start, .wip/, defs, Kanban, file, Write.
    const fresh = fake(["", "", "", "", "", "", ""]);
    await promptInit(["init"], tmp(), env, fresh);
    expect(fresh.said.join("\n")).not.toContain("needs `wip init --force`");
    expect(fresh.said.join("\n")).not.toContain("switch from");
  });

  test("declining the summary writes nothing", async () => {
    const dir = tmp();
    // scope, start, .wip/, defs, Kanban (no), Write (no).
    const out = await promptInit(["init"], dir, env, fake(["", "", "", "", "no", "n"]));
    expect(out).toEqual({ argv: null, code: 0 });
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("wip init flags without a terminal", () => {
  test("the templates carry the models and --yes saves the default start", () => {
    const dir = tmp();
    const out = wip(dir, ["init", "--yes"]);
    expect(out.code).toBe(0);
    expect(["haiku", "sonnet", "opus", "fable", "inherit"] as (string | null)[]).toEqual(
      ["fast", "efficient", "thinker", "wise", "wip"].map((a) => modelOf(dir, a)),
    );
    expect(config(dir).start).toEqual(CLAUDE_DEFAULT_START);
    const check = JSON.parse(wip(dir, ["check", "--json"]).stdout);
    expect(check.warnings.map((w: { code: string }) => w.code)).toEqual([]);
    expect(out.stdout).not.toContain("Still unset");
  });

  test("--no-start leaves start unset and init reports it", () => {
    const dir = tmp();
    const out = wip(dir, ["init", "--yes", "--no-start"]);
    expect(out.code).toBe(0);
    expect(config(dir).start).toBeUndefined();
    expect(out.stdout).toContain("Still unset: no start command");
  });

  test("--start is honoured; --force and --yes keep it", () => {
    const dir = tmp();
    const out = wip(dir, ["init", "--start", 'claude --name "a b"']);
    expect(out.code).toBe(0);
    expect(config(dir).start).toEqual(["claude", "--name", "a b"]);
    expect(out.stdout).not.toContain("Still unset");
    expect(wip(dir, ["init", "--force"]).code).toBe(0);
    expect(config(dir).start).toEqual(["claude", "--name", "a b"]);
    expect(wip(dir, ["init", "--yes"]).code).toBe(0);
    expect(config(dir).start).toEqual(["claude", "--name", "a b"]);
  });

  test("usage errors write nothing", () => {
    const dir = tmp();
    for (const argv of [
      ["init", "--models", "nope=x"],
      ["init", "--models", "fast=haiku"],
      ["init", "--start", "a", "--no-start"],
      ["init", "--start", 'a "b'],
      ["init", "--harness", "claude-code"],
    ]) {
      expect(wip(dir, argv).code).toBe(2);
      expect(existsSync(join(dir, ".wip"))).toBe(false);
    }
  });
});

describe("the Kanban step (4/4)", () => {
  const env = { PATH: "" };
  const said = (asker: { said: string[] }) => asker.said.join("\n");
  const asked = (asker: { asked: string[] }) => asker.asked.join("\n");
  /** scope, start, .wip/, defs, then the Kanban step and the Write. */
  const fresh = (kanbanAnswers: (string | null)[]) => fake(["", "", "", "", ...kanbanAnswers]);

  test("the first question is exact, `yes` is the default and Enter installs it", async () => {
    const dir = tmp();
    // Kanban Enter (yes), file Enter (settings.json), Write Enter.
    const asker = fresh(["", "", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect(asked(asker)).toContain("Install the wip Kanban mod for Claude Code? [no|yes] @1");
    expect(asked(asker)).toContain(
      "Where does the enabledPlugins entry go? [settings.json|settings.local.json] @0",
    );
    expect(said(asker)).toContain("default: yes");
    expect(said(asker)).toContain("4/4 Kanban");
    expect(said(asker)).toContain(
      "optional: a read-only board of the open items, shown by Claude Code",
    );
    expect(said(asker)).toMatch(/kanban\s+yes \(\.claude\/settings\.json\)/);
    expect(out.argv).toContain("--kanban");
    expect(out.argv).not.toContain("--kanban-settings-file");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("typing no skips the install", async () => {
    const dir = tmp();
    const asker = fresh(["no", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect(asked(asker)).toContain("Install the wip Kanban mod for Claude Code? [no|yes] @1");
    expect(asked(asker)).not.toContain("Where does the enabledPlugins entry go?");
    expect(said(asker)).toMatch(/kanban\s+no/);
    expect(out.argv).not.toContain("--kanban");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("yes then Enter uses settings.json and adds only --kanban", async () => {
    const dir = tmp();
    const asker = fresh(["yes", "", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect(asked(asker)).toContain(
      "Where does the enabledPlugins entry go? [settings.json|settings.local.json]",
    );
    expect(out.argv).toContain("--kanban");
    expect(out.argv).not.toContain("--kanban-settings-file");
    expect(said(asker)).toMatch(/kanban\s+yes \(\.claude\/settings\.json\)/);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("yes then settings.local.json adds the option and shows it in the summary", async () => {
    const dir = tmp();
    const asker = fresh(["yes", "2", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect((out.argv as string[]).slice(-3)).toEqual([
      "--kanban",
      "--kanban-settings-file",
      "settings.local.json",
    ]);
    expect(said(asker)).toMatch(/kanban\s+yes \(\.claude\/settings\.local\.json\)/);
  });

  test("a complete setup defaults to yes with its own file; a local entry defaults to the local file", async () => {
    const project = tmp();
    expect(wip(project, ["init", "--yes", "--kanban"]).code).toBe(0);
    // start, defs, yes (install), Enter (settings.json), Write.
    const asker = fake(["", "", "", "", ""]);
    const out = await promptInit(["init"], project, env, asker);
    expect(asked(asker)).not.toContain("Where do the agents and skills live");
    expect(asked(asker)).toContain("Install the wip Kanban mod for Claude Code? [no|yes] @1");
    expect(out.argv).toContain("--kanban");
    expect(out.argv).not.toContain("--kanban-settings-file");

    const local = tmp();
    expect(
      wip(local, ["init", "--yes", "--kanban", "--kanban-settings-file", "settings.local.json"])
        .code,
    ).toBe(0);
    const localAsker = fake(["", "", "", "", ""]);
    const localOut = await promptInit(["init"], local, env, localAsker);
    expect(asked(localAsker)).toContain("Install the wip Kanban mod for Claude Code? [no|yes] @1");
    expect(asked(localAsker)).toContain(
      "Where does the enabledPlugins entry go? [settings.json|settings.local.json] @1",
    );
    expect((localOut.argv as string[]).slice(-3)).toEqual([
      "--kanban",
      "--kanban-settings-file",
      "settings.local.json",
    ]);
  });

  test("a copy without an entry defaults to yes; a disabled entry defaults to no and its file", async () => {
    const dir = tmp();
    expect(wip(dir, ["init", "--yes", "--kanban"]).code).toBe(0);
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      `${JSON.stringify({ enabledPlugins: { "wip-kanban@skills-dir": false } })}\n`,
    );
    // start, defs, Kanban (no), Write.
    const asker = fake(["", "", "no", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect(said(asker)).toContain("the plugin is disabled in .claude/settings.json");
    expect(asked(asker)).toContain("Install the wip Kanban mod for Claude Code? [no|yes] @0");
    expect(out.argv).not.toContain("--kanban");

    const plain = tmp();
    expect(wip(plain, ["init", "--yes", "--kanban"]).code).toBe(0);
    rmSync(join(plain, ".claude", "settings.json"));
    // start, defs, Kanban (yes), file (settings.json), Write.
    const plainAsk = fake(["", "", "", "", ""]);
    const plainOut = await promptInit(["init"], plain, env, plainAsk);
    expect(said(plainAsk)).toContain("choosing yes adds the enabledPlugins entry");
    expect(asked(plainAsk)).toContain("Install the wip Kanban mod for Claude Code? [no|yes] @1");
    expect(plainOut.argv).toContain("--kanban");
    expect(plainOut.argv).not.toContain("--kanban-settings-file");
  });

  test("--kanban skips the first question and still asks the file", async () => {
    const dir = tmp();
    // scope, start, .wip/, defs, file, Write.
    const asker = fake(["", "", "", "", "", ""]);
    const out = await promptInit(["init", "--kanban"], dir, env, asker);
    expect(asked(asker)).not.toContain("Install the wip Kanban mod for Claude Code?");
    expect(asked(asker)).toContain("Where does the enabledPlugins entry go?");
    expect(said(asker)).toContain("from --kanban");
    expect((out.argv as string[]).filter((a) => a === "--kanban")).toHaveLength(1);
    expect(out.argv).not.toContain("--kanban-settings-file");
  });

  test("--kanban --force skips both questions and writes the default settings.json", async () => {
    const dir = tmp();
    // scope, start, .wip/, defs, Write.
    const asker = fake(["", "", "", "", ""]);
    const out = await promptInit(["init", "--kanban", "--force"], dir, env, asker);
    expect(asked(asker)).not.toContain("Install the wip Kanban mod for Claude Code?");
    expect(asked(asker)).not.toContain("Where does the enabledPlugins entry go?");
    expect(said(asker)).toContain("--kanban --force installs with the defaults");
    expect(out.argv).toContain("--kanban");
    expect(out.argv).not.toContain("--kanban-settings-file");
  });

  test("--kanban --force still honours an explicit --kanban-settings-file", async () => {
    // scope, start, .wip/, defs, Write.
    const asker = fake(["", "", "", "", ""]);
    const out = await promptInit(
      ["init", "--kanban", "--force", "--kanban-settings-file", "settings.local.json"],
      tmp(),
      env,
      asker,
    );
    expect(asked(asker)).not.toContain("Where does the enabledPlugins entry go?");
    expect(asked(asker)).not.toContain("Install the wip Kanban mod for Claude Code?");
    expect(out.argv).toContain("settings.local.json");
  });

  test("--kanban-settings-file skips the second question and is not duplicated", async () => {
    const dir = tmp();
    // scope, start, .wip/, defs, Write.
    const asker = fake(["", "", "", "", ""]);
    const out = await promptInit(
      ["init", "--kanban", "--kanban-settings-file", "settings.local.json"],
      dir,
      env,
      asker,
    );
    expect(asked(asker)).not.toContain("Where does the enabledPlugins entry go?");
    expect(said(asker)).toContain("from --kanban-settings-file settings.local.json");
    expect((out.argv as string[]).filter((a) => a === "--kanban")).toHaveLength(1);
    expect((out.argv as string[]).filter((a) => a === "--kanban-settings-file")).toHaveLength(1);
  });

  test("the option without --kanban is not asked and reaches the command", async () => {
    const dir = tmp();
    const asker = fake([]);
    const out = await promptInit(
      ["init", "--kanban-settings-file", "settings.local.json"],
      dir,
      env,
      asker,
    );
    expect(asker.asked).toEqual([]);
    expect(out).toEqual({
      argv: ["init", "--kanban-settings-file", "settings.local.json"],
      code: 0,
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  test("Ctrl+C in either question aborts with 130 and writes nothing", async () => {
    const first = await promptInit(["init"], tmp(), env, fresh([null]));
    expect(first).toEqual({ argv: null, code: 130 });
    const dir = tmp();
    const second = await promptInit(["init"], dir, env, fresh(["yes", null]));
    expect(second).toEqual({ argv: null, code: 130 });
    expect(readdirSync(dir)).toEqual([]);
  });

  test("--force with a copy notes that it refreshes it even with no; --global notes the project copy", async () => {
    const dir = tmp();
    expect(wip(dir, ["init", "--yes", "--kanban"]).code).toBe(0);
    // start, defs, Kanban (no), Write.
    const asker = fake(["", "", "no", ""]);
    await promptInit(["init", "--force"], dir, env, asker);
    expect(said(asker)).toContain("--force refreshes the copy even when the answer is no");

    const home = tmp();
    // start, .wip/, Kanban (no), Write.
    const globalAsker = fake(["", "", "no", ""]);
    await promptInit(["init", "--global"], tmp(), { PATH: "", HOME: home }, globalAsker);
    expect(said(globalAsker)).toContain("the mod is installed in this project anyway");
  });

  test("a foreign folder defaults to no with the conflict note", async () => {
    const dir = tmp();
    mkdirSync(join(dir, ".claude", "skills", "wip-kanban"), { recursive: true });
    const asker = fresh(["", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect(asked(asker)).toContain("Install the wip Kanban mod for Claude Code? [no|yes] @0");
    expect(said(asker)).toContain("another plugin's folder");
    expect(out.argv).not.toContain("--kanban");
  });

  test("a broken settings.json sends the default to settings.local.json", async () => {
    const dir = tmp();
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), "{oops");
    const asker = fresh(["", "", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect(asked(asker)).toContain("Install the wip Kanban mod for Claude Code? [no|yes] @1");
    expect(asked(asker)).toContain(
      "Where does the enabledPlugins entry go? [settings.json|settings.local.json] @1",
    );
    expect(said(asker)).toContain("unreadable");
    expect(out.argv).toContain("--kanban");
    expect(out.argv).toContain("--kanban-settings-file");
    expect(out.argv).toContain("settings.local.json");
  });
});
