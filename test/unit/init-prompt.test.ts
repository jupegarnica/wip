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
  multiSelectStep,
  optionsError,
  redraw,
  renderMultiSelect,
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
    multiSelect: async (spec) => {
      asked.push(
        `${spec.question} [${spec.options.map((o) => o.value).join("|")}] @${spec.initial.join(",")}`,
      );
      for (;;) {
        const a = next();
        if (a === null) return null;
        const picked: string[] = [];
        let ok = true;
        if (a.trim() !== "") {
          for (const token of a.split(",")) {
            const i = resolveOption(token.trim(), spec.options);
            if (i < 0) {
              ok = false;
              break;
            }
            const value = (spec.options[i] as ISelectOption).value;
            if (!picked.includes(value)) picked.push(value);
          }
        } else {
          picked.push(...spec.initial);
        }
        if (ok && picked.length >= (spec.min ?? 1)) {
          return spec.options.filter((o) => picked.includes(o.value)).map((o) => o.value);
        }
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
  const MST = { cursor: 0, checked: ["alpha"], buffer: "", error: null };
  test("multi-select: arrows move, Space toggles, at least one stays checked, Enter returns the checks", () => {
    expect(multiSelectStep(MST, "\x1b[B", OPTIONS)).toEqual({
      state: { cursor: 1, checked: ["alpha"], buffer: "", error: null },
    });
    const on = multiSelectStep({ ...MST, cursor: 1 }, " ", OPTIONS) as { state: typeof MST };
    expect(on.state.checked).toEqual(["alpha", "beta"]);
    const off = multiSelectStep(on.state, " ", OPTIONS) as { state: typeof MST };
    expect(off.state.checked).toEqual(["alpha"]);
    const last = multiSelectStep(MST, " ", OPTIONS) as { state: typeof MST };
    expect(String(last.state.error)).toBe("keep at least 1 checked");
    expect(multiSelectStep({ ...MST, checked: ["alpha", "beta"] }, "\r", OPTIONS)).toEqual({
      done: ["alpha", "beta"],
    });
  });
  test("multi-select: typing names or numbers replaces the selection; junk is refused", () => {
    const typed = (text: string) => {
      let st = MST;
      for (const c of text) st = (multiSelectStep(st, c, OPTIONS) as { state: typeof MST }).state;
      return st;
    };
    expect(multiSelectStep(typed("2"), "\r", OPTIONS)).toEqual({ done: ["beta"] });
    expect(multiSelectStep(typed("alpha,beta"), "\r", OPTIONS)).toEqual({
      done: ["alpha", "beta"],
    });
    const refused = multiSelectStep(typed("nope"), "\r", OPTIONS) as { state: typeof MST };
    expect(refused.state.error ?? "").toContain("not an option");
    expect(multiSelectStep(MST, "\x03", OPTIONS)).toEqual({ abort: true });
  });
  test("multi-select renders the checks, the cursor and the toggle hint", () => {
    const lines = renderMultiSelect(
      { question: "Flows?", options: OPTIONS, initial: ["beta"] },
      { cursor: 0, checked: ["beta"], buffer: "", error: null },
      PLAIN,
    ).join("\n");
    expect(lines).toContain("[ ] 1) alpha");
    expect(lines).toContain("[x] 2) beta");
    expect(lines).toContain("Space toggle");
    expect(lines).not.toContain("\x1b");
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
    // scope, flows, start, .wip/, defs, Kanban (yes), file, Quiet (yes), Write.
    const asker = fake(["", "", "", "", "", "", "", "", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect(asker.asked[0]).toBe("Where do the agents and skills live? [local|global] @0");
    expect(asker.said.join("\n")).toContain("1/6 Scope");
    expect(asker.said.join("\n")).toMatch(/scope\s+local/);
    expect(out.argv).not.toContain("--global");
  });

  test("the wizard asks no model and init writes the templates' models", async () => {
    const dir = tmp();
    // scope, flows, start, .wip/, defs, Kanban (no), Quiet (no), Write.
    const asker = fake(["", "", "", "", "", "no", "no", ""]);
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

  test("no to both mods keeps argv to the start and Git answers", async () => {
    const dir = tmp();
    // scope, flows, start, .wip/, defs, Kanban (no), Quiet (no), Write.
    const asker = fake(["", "", "", "", "", "no", "no", ""]);
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

  test("the Flows step is 2/6 with all four checked; Enter keeps all and adds no --flows", async () => {
    const dir = tmp();
    // scope, flows, start, .wip/, defs, Kanban (no), Quiet (no), Write.
    const asker = fake(["", "", "", "", "", "no", "no", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect(asker.asked).toContain(
      "Which flows should wip write? [development|ideas|reports|tasks] @development,ideas,reports,tasks",
    );
    expect(asker.said.join("\n")).toContain("2/6 Flows");
    expect(asker.said.join("\n")).toMatch(/flows\s+development, ideas, reports, tasks/);
    expect(out.argv).not.toContain("--flows");
    expect(wip(dir, out.argv as string[]).code).toBe(0);
    expect(
      readdirSync(join(dir, ".claude", "skills"))
        .filter((n) => n.startsWith("wip-flow-"))
        .sort(),
    ).toEqual(["wip-flow-development", "wip-flow-ideas", "wip-flow-reports", "wip-flow-tasks"]);
  });

  test("a smaller selection adds --flows and the run writes only those flows", async () => {
    const dir = tmp();
    // scope, flows (tasks), start, .wip/, defs, Kanban (no), Quiet (no), Write.
    const asker = fake(["", "tasks", "", "", "", "no", "no", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect(asker.said.join("\n")).toMatch(/flows\s+tasks/);
    expect(out.argv).toContain("--flows");
    expect(out.argv).toContain("tasks");
    const res = wip(dir, out.argv as string[]);
    expect(res.code).toBe(0);
    expect(
      readdirSync(join(dir, ".claude", "skills"))
        .filter((n) => n.startsWith("wip-flow-"))
        .sort(),
    ).toEqual(["wip-flow-tasks"]);
    expect(res.stdout).toContain("seeded item onboarding");
  });

  test("--flows skips the Flows step and is not duplicated", async () => {
    const dir = tmp();
    // scope, start, .wip/, defs, Kanban (yes), file, Quiet (yes), Write.
    const asker = fake(["", "", "", "", "", "", "", ""]);
    const out = await promptInit(["init", "--flows", "ideas"], dir, env, asker);
    expect(asker.asked.join("\n")).not.toContain("Which flows");
    expect(asker.said.join("\n")).toContain("from --flows ideas");
    expect(asker.said.join("\n")).toMatch(/flows\s+ideas/);
    expect((out.argv as string[]).filter((a) => a === "--flows")).toHaveLength(1);
  });

  test("an unknown --flows value is not asked and reaches the command's usage error", async () => {
    const dir = tmp();
    const asker = fake([]);
    const out = await promptInit(["init", "--flows", "nope"], dir, env, asker);
    expect(asker.asked).toEqual([]);
    expect(out).toEqual({ argv: ["init", "--flows", "nope"], code: 0 });
    expect(wip(dir, ["init", "--flows", "nope"]).code).toBe(2);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a bad start command asks again", async () => {
    const dir = tmp();
    const asker = fake(["", "", "claude {nope}", "claude --agent wip", "", "", "no", "no", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect(asker.said.join("\n")).toContain("unknown variable {nope}");
    expect(out.argv).toContain("claude --agent wip");
  });

  test("an existing agent's model line is left alone and never asked about", async () => {
    const dir = tmp();
    expect(wip(dir, ["init", "--yes"]).code).toBe(0);
    const file = join(dir, ".claude", "agents", "thinker.md");
    writeFileSync(file, readFileSync(file, "utf8").replace(/^model: .*$/m, "model: sonnet"));
    // flows, start, defs, Kanban (no), Quiet (no), Write.
    const asker = fake(["", "", "", "no", "no", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect(asker.asked.join("\n")).not.toContain("Model of");
    expect((out.argv as string[]).join(" ")).not.toContain("--models");
    expect(modelOf(dir, "thinker")).toBe("sonnet");
  });

  test("answer global adds --global and the summary shows the folder under HOME", async () => {
    for (const pick of ["2", "global"]) {
      const dir = tmp();
      const home = tmp();
      // scope (global), flows, start, .wip/, Kanban (yes), file, Quiet (yes), Write.
      const asker = fake([pick, "", "", "", "", "", "", ""]);
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
    // flows, start, .wip/, Kanban (yes), file, Quiet (yes), Write.
    const asker = fake(["", "", "", "", "", "", ""]);
    const out = await promptInit(["init", "--global"], dir, { PATH: "", HOME: home }, asker);
    expect(asker.asked.join("\n")).not.toContain("Where do the agents and skills live");
    expect(asker.said.join("\n")).toContain("from --global");
    expect((out.argv as string[]).filter((a) => a === "--global")).toHaveLength(1);
  });

  test("an initialised project shows scope kept and asks nothing about scope", async () => {
    const dir = tmp();
    expect(wip(dir, ["init", "--yes"]).code).toBe(0);
    // flows, start, defs, Kanban (no), Quiet (no), Write.
    const asker = fake(["", "", "", "no", "no", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect(asker.asked.join("\n")).not.toContain("Where do the agents and skills live");
    expect(asker.said.join("\n")).toContain("scope kept: local");
    expect(out.argv).not.toContain("--global");

    const dirG = tmp();
    const home = tmp();
    const genv = { PATH: "", HOME: home };
    expect(run(["init", "--yes", "--global"], { cwd: dirG, env: genv }).code).toBe(0);
    // flows, start, Kanban (no), Quiet (no), Write.
    const askerG = fake(["", "", "no", "no", ""]);
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
    // scope, flows, start, .wip/, defs, Kanban (no), Quiet (no), Write.
    const asker = fake(["", "", "", "", "", "no", "no", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect(asker.said.join("\n")).toContain("4/6 Git");
    expect(asker.said.join("\n")).toMatch(/gitignore\s+wip/);
    expect(out.argv?.slice(-2)).toEqual(["--gitignore", "wip"]);
  });

  test("no to .wip/ and yes to defs gives --gitignore defs; both no gives none", async () => {
    const a = fake(["", "", "", "n", "y", "no", "no", ""]);
    expect((await promptInit(["init"], tmp(), env, a)).argv?.slice(-2)).toEqual([
      "--gitignore",
      "defs",
    ]);
    const b = fake(["", "", "", "n", "n", "no", "no", ""]);
    expect((await promptInit(["init"], tmp(), env, b)).argv?.slice(-2)).toEqual([
      "--gitignore",
      "none",
    ]);
  });

  test("an already ignored .wip/ is not asked; --gitignore skips the step; global asks no defs", async () => {
    const dir = tmp();
    expect(wip(dir, ["init", "--yes"]).code).toBe(0);
    // flows, start, defs, Kanban (no), Quiet (no), Write.
    const a = fake(["", "", "", "no", "no", ""]);
    const out = await promptInit(["init"], dir, env, a);
    expect(a.said.join("\n")).toContain(".wip/ already ignored");
    expect(out.argv).not.toContain("--gitignore");

    // scope, flows, start, Kanban (no), Quiet (no), Write.
    const b = fake(["", "", "", "no", "no", ""]);
    const outB = await promptInit(["init", "--gitignore", "none"], tmp(), env, b);
    expect(b.said.join("\n")).toContain("from --gitignore none");
    expect(b.asked.join("\n")).not.toContain("Ignore .wip/");
    expect(outB.argv?.filter((x) => x === "--gitignore")).toHaveLength(1);

    const home = tmp();
    // flows, start, .wip/, Kanban (no), Quiet (no), Write.
    const c = fake(["", "", "", "no", "no", ""]);
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
    // flows, start, defs, Kanban (no), Quiet (no), Write.
    const asker = fake(["", "", "", "no", "no", ""]);
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
    // flows, start, .wip/, Kanban (no), Quiet (no), Write.
    const asker = fake(["", "", "", "no", "no", ""]);
    await promptInit(["init"], dir, genv, asker);
    expect(asker.said.join("\n")).toContain(
      `this project uses ${join(home, ".agents")}/; wip now writes ${join(home, ".claude")}/`,
    );
  });

  test("no switch note when the folder is the kept one or there is no config", async () => {
    const dir = tmp();
    expect(wip(dir, ["init", "--yes"]).code).toBe(0);
    // flows, start, defs, Kanban (no), Quiet (no), Write.
    const same = fake(["", "", "", "no", "no", ""]);
    await promptInit(["init"], dir, env, same);
    expect(same.said.join("\n")).not.toContain("needs `wip init --force`");
    expect(same.said.join("\n")).not.toContain("switch from");

    // scope, flows, start, .wip/, defs, Kanban (no), Quiet (no), Write.
    const fresh = fake(["", "", "", "", "", "no", "no", ""]);
    await promptInit(["init"], tmp(), env, fresh);
    expect(fresh.said.join("\n")).not.toContain("needs `wip init --force`");
    expect(fresh.said.join("\n")).not.toContain("switch from");
  });

  test("declining the summary writes nothing", async () => {
    const dir = tmp();
    // scope, flows, start, .wip/, defs, Kanban (no), Quiet (no), Write (no).
    const out = await promptInit(["init"], dir, env, fake(["", "", "", "", "", "no", "no", "n"]));
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
      ["init", "--mods-settings-file", "settings.local.json"],
      ["init", "--mods-settings-file", "other.json", "--quiet"],
      ["init", "--kanban-settings-file", "settings.local.json"],
    ]) {
      expect(wip(dir, argv).code).toBe(2);
      expect(existsSync(join(dir, ".wip"))).toBe(false);
    }
  });
});

describe("the mods steps (5/6 and 6/6)", () => {
  const env = { PATH: "" };
  const said = (asker: { said: string[] }) => asker.said.join("\n");
  const asked = (asker: { asked: string[] }) => asker.asked.join("\n");
  /** scope, flows, start, .wip/, defs, then the mods steps and the Write. */
  const fresh = (answers: (string | null)[]) => fake(["", "", "", "", "", ...answers]);
  const KANBAN_Q = "Install the wip Kanban mod for Claude Code?";
  const QUIET_Q = "Install the wip Quiet mod for Claude Code?";
  const FILE_Q = "Where does the enabledPlugins entry go?";

  test("the first question is exact, `yes` is the default and Enter installs both mods", async () => {
    const dir = tmp();
    // Kanban Enter (yes), file Enter (settings.json), Quiet Enter (yes), Write Enter.
    const asker = fresh(["", "", "", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect(asked(asker)).toContain(`${KANBAN_Q} [no|yes] @1`);
    expect(asked(asker)).toContain(
      "Where does the enabledPlugins entry go? [settings.json|settings.local.json] @0",
    );
    expect(asked(asker)).toContain(`${QUIET_Q} [no|yes] @1`);
    expect(said(asker)).toContain("default: yes");
    expect(said(asker)).toContain("5/6 Kanban");
    expect(said(asker)).toContain("6/6 Quiet");
    expect(said(asker)).toContain(
      "optional: a read-only board of the open items, shown by Claude Code",
    );
    expect(said(asker)).toContain("optional: a quieter transcript, shown by Claude Code");
    expect(said(asker)).toMatch(/kanban\s+yes/);
    expect(said(asker)).toMatch(/quiet\s+yes/);
    expect(said(asker)).toMatch(/settings\s+\.claude\/settings\.json/);
    expect(out.argv).toContain("--kanban");
    expect(out.argv).toContain("--quiet");
    expect(out.argv).not.toContain("--mods-settings-file");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("typing no to both skips both installs and asks no file", async () => {
    const dir = tmp();
    const asker = fresh(["no", "no", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect(asked(asker)).toContain(`${KANBAN_Q} [no|yes] @1`);
    expect(asked(asker)).toContain(`${QUIET_Q} [no|yes] @1`);
    expect(asked(asker)).not.toContain(FILE_Q);
    expect(said(asker)).toMatch(/kanban\s+no/);
    expect(said(asker)).toMatch(/quiet\s+no/);
    expect(said(asker)).not.toMatch(/settings\s+\.claude/);
    expect(out.argv).not.toContain("--kanban");
    expect(out.argv).not.toContain("--quiet");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("yes to Kanban and no to Quiet asks the file once and adds only --kanban", async () => {
    const dir = tmp();
    const asker = fresh(["", "", "no", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect(asked(asker)).toContain(FILE_Q);
    expect((asked(asker).match(/Where does the enabledPlugins entry go\?/g) ?? []).length).toBe(1);
    expect(out.argv).toContain("--kanban");
    expect(out.argv).not.toContain("--quiet");
    expect(out.argv).not.toContain("--mods-settings-file");
    expect(said(asker)).toMatch(/kanban\s+yes/);
    expect(said(asker)).toMatch(/settings\s+\.claude\/settings\.json/);
  });

  test("no to Kanban and yes to Quiet asks the file in step 6", async () => {
    const dir = tmp();
    const asker = fresh(["no", "", "", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect(asked(asker)).toContain(FILE_Q);
    expect(out.argv).not.toContain("--kanban");
    expect(out.argv).toContain("--quiet");
    expect(said(asker)).toMatch(/quiet\s+yes/);
    expect(said(asker)).toMatch(/settings\s+\.claude\/settings\.json/);
  });

  test("yes then settings.local.json adds one shared --mods-settings-file for both", async () => {
    const dir = tmp();
    // Kanban yes, file 2 (local), Quiet yes (no repeat), Write.
    const asker = fresh(["", "2", "", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect((out.argv as string[]).filter((a) => a === "--kanban")).toHaveLength(1);
    expect((out.argv as string[]).filter((a) => a === "--quiet")).toHaveLength(1);
    expect((out.argv as string[]).filter((a) => a === "--mods-settings-file")).toHaveLength(1);
    expect(out.argv).toContain("settings.local.json");
    expect(said(asker)).toMatch(/settings\s+\.claude\/settings\.local\.json/);
  });

  test("a complete setup defaults to yes with its own file; a local entry defaults to the local file", async () => {
    const project = tmp();
    expect(wip(project, ["init", "--yes", "--kanban"]).code).toBe(0);
    // flows, start, defs, Kanban (yes), file Enter (settings.json), Quiet (yes), Write.
    const asker = fake(["", "", "", "", "", "", ""]);
    const out = await promptInit(["init"], project, env, asker);
    expect(asked(asker)).not.toContain("Where do the agents and skills live");
    expect(asked(asker)).toContain(`${KANBAN_Q} [no|yes] @1`);
    expect(asked(asker)).toContain(`${QUIET_Q} [no|yes] @1`);
    expect(out.argv).toContain("--kanban");
    expect(out.argv).toContain("--quiet");
    expect(out.argv).not.toContain("--mods-settings-file");

    const local = tmp();
    expect(
      wip(local, ["init", "--yes", "--kanban", "--kanban-settings-file", "settings.local.json"])
        .code,
    ).toBe(0);
    const localAsker = fake(["", "", "", "", "", "", ""]);
    const localOut = await promptInit(["init"], local, env, localAsker);
    expect(asked(localAsker)).toContain(`${KANBAN_Q} [no|yes] @1`);
    expect(asked(localAsker)).toContain(
      "Where does the enabledPlugins entry go? [settings.json|settings.local.json] @1",
    );
    expect(localOut.argv).toContain("--mods-settings-file");
    expect(localOut.argv).toContain("settings.local.json");
  });

  test("a disabled entry defaults to no and its file; a copy without an entry defaults to yes", async () => {
    const dir = tmp();
    expect(wip(dir, ["init", "--yes", "--kanban"]).code).toBe(0);
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      `${JSON.stringify({ enabledPlugins: { "wip-kanban@skills-dir": false } })}\n`,
    );
    // flows, start, defs, Kanban (no), Quiet (yes), file, Write.
    const asker = fake(["", "", "", "no", "", "", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect(said(asker)).toContain("the plugin is disabled in .claude/settings.json");
    expect(asked(asker)).toContain(`${KANBAN_Q} [no|yes] @0`);
    expect(out.argv).not.toContain("--kanban");
    expect(out.argv).toContain("--quiet");

    const plain = tmp();
    expect(wip(plain, ["init", "--yes", "--kanban"]).code).toBe(0);
    rmSync(join(plain, ".claude", "settings.json"));
    // flows, start, defs, Kanban (yes), file (settings.json), Quiet (yes), Write.
    const plainAsk = fake(["", "", "", "", "", "", ""]);
    const plainOut = await promptInit(["init"], plain, env, plainAsk);
    expect(said(plainAsk)).toContain("choosing yes adds the enabledPlugins entry");
    expect(asked(plainAsk)).toContain(`${KANBAN_Q} [no|yes] @1`);
    expect(plainOut.argv).toContain("--kanban");
    expect(plainOut.argv).not.toContain("--mods-settings-file");
  });

  test("a quiet entry explicitly false makes its default no; a foreign quiet folder too", async () => {
    const off = tmp();
    mkdirSync(join(off, ".claude"), { recursive: true });
    writeFileSync(
      join(off, ".claude", "settings.json"),
      `${JSON.stringify({ enabledPlugins: { "wip-quiet@skills-dir": false } })}\n`,
    );
    // Kanban (?) -> no, Quiet default no, Write.
    const asker = fresh(["no", "", ""]);
    await promptInit(["init"], off, env, asker);
    expect(asked(asker)).toContain(`${QUIET_Q} [no|yes] @0`);
    expect(said(asker)).toContain("the plugin is disabled in .claude/settings.json");

    const foreign = tmp();
    mkdirSync(join(foreign, ".claude", "skills", "wip-quiet"), { recursive: true });
    const foreignAsk = fresh(["no", "", ""]);
    await promptInit(["init"], foreign, env, foreignAsk);
    expect(asked(foreignAsk)).toContain(`${QUIET_Q} [no|yes] @0`);
    expect(said(foreignAsk)).toContain("another plugin's folder");
  });

  test("--kanban skips its question but still asks the file and Quiet", async () => {
    const dir = tmp();
    // scope, flows, start, .wip/, defs, file, Quiet (yes), Write.
    const asker = fake(["", "", "", "", "", "", "", ""]);
    const out = await promptInit(["init", "--kanban"], dir, env, asker);
    expect(asked(asker)).not.toContain(KANBAN_Q);
    expect(asked(asker)).toContain(FILE_Q);
    expect(asked(asker)).toContain(QUIET_Q);
    expect(said(asker)).toContain("from --kanban");
    expect((out.argv as string[]).filter((a) => a === "--kanban")).toHaveLength(1);
    expect(out.argv).not.toContain("--mods-settings-file");
  });

  test("--quiet skips its question, installs it and still asks the shared file", async () => {
    const dir = tmp();
    // scope, flows, start, .wip/, defs, Kanban (no), file, Write.
    const asker = fake(["", "", "", "", "", "no", "", ""]);
    const out = await promptInit(["init", "--quiet"], dir, env, asker);
    expect(asked(asker)).not.toContain(QUIET_Q);
    expect(asked(asker)).toContain(FILE_Q);
    expect(said(asker)).toContain("from --quiet");
    expect((out.argv as string[]).filter((a) => a === "--quiet")).toHaveLength(1);
    expect(out.argv).not.toContain("--kanban");
  });

  test("--kanban --force skips both mod questions and writes the default settings.json", async () => {
    const dir = tmp();
    // scope, flows, start, .wip/, defs, Quiet (yes), Write.
    const asker = fake(["", "", "", "", "", "", ""]);
    const out = await promptInit(["init", "--kanban", "--force"], dir, env, asker);
    expect(asked(asker)).not.toContain(KANBAN_Q);
    expect(asked(asker)).not.toContain(FILE_Q);
    expect(asked(asker)).toContain(QUIET_Q);
    expect(said(asker)).toContain("--kanban --force installs with the defaults");
    expect(out.argv).toContain("--kanban");
    expect(out.argv).toContain("--quiet");
    expect(out.argv).not.toContain("--mods-settings-file");
  });

  test("--kanban --force still honours an explicit settings file", async () => {
    // scope, flows, start, .wip/, defs, Quiet (yes), Write.
    const asker = fake(["", "", "", "", "", "", ""]);
    const out = await promptInit(
      ["init", "--kanban", "--force", "--mods-settings-file", "settings.local.json"],
      tmp(),
      env,
      asker,
    );
    expect(asked(asker)).not.toContain(FILE_Q);
    expect(asked(asker)).not.toContain(KANBAN_Q);
    expect(out.argv).toContain("settings.local.json");
    expect(said(asker)).toContain("from --mods-settings-file settings.local.json");
  });

  test("an explicit --mods-settings-file suppresses the question and is not duplicated", async () => {
    const dir = tmp();
    // scope, flows, start, .wip/, defs, Quiet (yes), Write.
    const asker = fake(["", "", "", "", "", "", ""]);
    const out = await promptInit(
      ["init", "--kanban", "--mods-settings-file", "settings.local.json"],
      dir,
      env,
      asker,
    );
    expect(asked(asker)).not.toContain(KANBAN_Q);
    expect(asked(asker)).not.toContain(FILE_Q);
    expect(said(asker)).toContain("from --mods-settings-file settings.local.json");
    expect((out.argv as string[]).filter((a) => a === "--mods-settings-file")).toHaveLength(1);
    expect(out.argv).toContain("--kanban");
    expect(out.argv).toContain("--quiet");
  });

  test("the deprecated --kanban-settings-file is shown as deprecated", async () => {
    const dir = tmp();
    // scope, flows, start, .wip/, defs, Quiet (yes), Write.
    const asker = fake(["", "", "", "", "", "", ""]);
    const out = await promptInit(
      ["init", "--kanban", "--kanban-settings-file", "settings.local.json"],
      dir,
      env,
      asker,
    );
    expect(asked(asker)).not.toContain(FILE_Q);
    expect(said(asker)).toContain("from --kanban-settings-file settings.local.json (deprecated)");
    expect((out.argv as string[]).filter((a) => a === "--kanban")).toHaveLength(1);
    expect((out.argv as string[]).filter((a) => a === "--kanban-settings-file")).toHaveLength(1);
  });

  test("the alias without --kanban is not asked and reaches the command", async () => {
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

  test("Ctrl+C in any mod question aborts with 130 and writes nothing", async () => {
    const first = await promptInit(["init"], tmp(), env, fresh([null]));
    expect(first).toEqual({ argv: null, code: 130 });
    const dir = tmp();
    const second = await promptInit(["init"], dir, env, fresh(["yes", null]));
    expect(second).toEqual({ argv: null, code: 130 });
    const third = await promptInit(["init"], dir, env, fresh(["no", null]));
    expect(third).toEqual({ argv: null, code: 130 });
    expect(readdirSync(dir)).toEqual([]);
  });

  test("--force with a copy notes that it refreshes it even with no; --global notes the project copy", async () => {
    const dir = tmp();
    expect(wip(dir, ["init", "--yes", "--kanban"]).code).toBe(0);
    // flows, start, defs, Kanban (no), Quiet (no), Write.
    const asker = fake(["", "", "", "no", "no", ""]);
    await promptInit(["init", "--force"], dir, env, asker);
    expect(said(asker)).toContain("--force refreshes the copy even when the answer is no");
    expect(said(asker)).toContain("only --quiet changes settings");

    const home = tmp();
    // flows, start, .wip/, Kanban (no), Quiet (no), Write.
    const globalAsker = fake(["", "", "", "no", "no", ""]);
    await promptInit(["init", "--global"], tmp(), { PATH: "", HOME: home }, globalAsker);
    expect(said(globalAsker)).toContain("the mod is installed in this project anyway");
    expect(said(globalAsker)).toContain(".claude/skills/wip-quiet/");
  });

  test("a foreign folder defaults to no with the conflict note", async () => {
    const dir = tmp();
    mkdirSync(join(dir, ".claude", "skills", "wip-kanban"), { recursive: true });
    // Kanban default no, Quiet (yes), file, Write.
    const asker = fresh(["", "", "", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect(asked(asker)).toContain(`${KANBAN_Q} [no|yes] @0`);
    expect(said(asker)).toContain("another plugin's folder");
    expect(out.argv).not.toContain("--kanban");
    expect(out.argv).toContain("--quiet");
  });

  test("a broken settings.json sends the default to settings.local.json", async () => {
    const dir = tmp();
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), "{oops");
    // Kanban (yes), file, Quiet (yes), Write.
    const asker = fresh(["", "", "", ""]);
    const out = await promptInit(["init"], dir, env, asker);
    expect(asked(asker)).toContain(`${KANBAN_Q} [no|yes] @1`);
    expect(asked(asker)).toContain(
      "Where does the enabledPlugins entry go? [settings.json|settings.local.json] @1",
    );
    expect(said(asker)).toContain("unreadable");
    expect(out.argv).toContain("--kanban");
    expect(out.argv).toContain("--quiet");
    expect(out.argv).toContain("--mods-settings-file");
    expect(out.argv).toContain("settings.local.json");
  });
});
