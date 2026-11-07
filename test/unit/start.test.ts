import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isStartLaunch } from "../../src/cli.ts";
import {
  childWipBin,
  expandStart,
  type IStartVars,
  launchBin,
  resolveStart,
  startMode,
  startStamp,
  syncWipBin,
} from "../../src/commands/start.ts";
import {
  configPath,
  defaultStart,
  parseStartTemplate,
  readConfig,
  readStart,
  validateStart,
  writeConfig,
} from "../../src/config.ts";

const VARS: IStartVars = {
  stamp: "26-11-03-09-05",
  project: "demo",
  root: "/work/demo",
  defs: "/work/demo/.claude",
};

let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "wip-start-"));
  mkdirSync(join(project, ".wip"));
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

const put = (obj: unknown) => writeFileSync(configPath(project), JSON.stringify(obj));
const raw = () => JSON.parse(readFileSync(configPath(project), "utf8")) as Record<string, unknown>;

describe("stamp and expansion", () => {
  test("the stamp is local time, YY-MM-DD-hh-mm", () => {
    expect(startStamp(new Date(2026, 10, 3, 9, 5))).toBe("26-11-03-09-05");
  });

  test("variables are replaced inside each element, and elements never split", () => {
    const out = expandStart(
      ["claude", "--name", "wip-{stamp}", "{project} at {root}", "{defs}"],
      VARS,
    );
    expect(out).toEqual([
      "claude",
      "--name",
      "wip-26-11-03-09-05",
      "demo at /work/demo",
      "/work/demo/.claude",
    ]);
  });

  test("{{ and }} are literal braces", () => {
    expect(expandStart(["{{stamp}}", "a}}b"], VARS)).toEqual(["{stamp}", "a}b"]);
  });

  test("an unknown variable, a stray brace or an empty name is an error", () => {
    expect(() => parseStartTemplate("x-{nope}")).toThrow(/unknown variable \{nope\}/);
    expect(() => parseStartTemplate("a{b")).toThrow(/stray/);
    expect(() => parseStartTemplate("a}b")).toThrow(/stray/);
    expect(() => parseStartTemplate("{}")).toThrow(/unknown variable/);
  });
});

describe("validation", () => {
  test("a start is a non-empty array of non-empty strings", () => {
    expect(validateStart(["claude", "--agent", "wip"])).toEqual(["claude", "--agent", "wip"]);
    expect(() => validateStart([])).toThrow(/non-empty array/);
    expect(() => validateStart("claude")).toThrow(/non-empty array/);
    expect(() => validateStart([""])).toThrow(/element 0/);
    expect(() => validateStart(["claude", 3])).toThrow(/element 1/);
    expect(() => validateStart(["{bad}"])).toThrow(/unknown variable/);
  });

  test("an invalid start does not break the config, but readStart reports it", () => {
    put({ defs_dir: ".claude", start: ["{bad}"] });
    expect(readConfig(project)?.defs_dir).toBe(".claude");
    expect(() => readStart(project)).toThrow(/invalid start/);
  });

  test("an absent or null start is null", () => {
    put({ defs_dir: ".claude" });
    expect(readStart(project)).toBeNull();
  });
});

describe("writeConfig", () => {
  test("keeps keys it does not know, such as start, and drops a legacy harness when init rewrites the file", () => {
    put({ defs_dir: ".agents", harness: "claude-code", start: ["echo", "{stamp}"] });
    writeConfig(project, { defs_dir: ".claude", wip_bin: null });
    expect(raw()).toEqual({ defs_dir: ".claude", start: ["echo", "{stamp}"] });
    expect(readStart(project)).toEqual(["echo", "{stamp}"]);
  });

  test("a missing config is created with the default folder, and no temporary file is left", () => {
    writeConfig(project, { start: ["claude"] });
    expect(raw()).toEqual({ defs_dir: ".claude", start: ["claude"] });
    expect(readFileSync(configPath(project), "utf8").endsWith("}\n")).toBe(true);
    expect(readdirSync(join(project, ".wip"))).toEqual(["config.json"]);
  });

  test("start null removes the key; wip_bin null is not written", () => {
    put({ defs_dir: ".claude", start: ["claude"] });
    writeConfig(project, { start: null, wip_bin: null });
    expect(raw()).toEqual({ defs_dir: ".claude" });
  });
});

describe("resolving the command", () => {
  test("the saved start wins, else the default Claude Code command", () => {
    put({ defs_dir: ".claude" });
    expect(resolveStart(project)).toEqual({ template: defaultStart(), origin: "default" });
    put({ defs_dir: ".agents", start: ["tool"] });
    expect(resolveStart(project)).toEqual({ template: ["tool"], origin: "config" });
  });

  test("the default is the proposal of the runtime interface paragraph in wip-coordinate", () => {
    const skill = readFileSync(
      join(import.meta.dir, "..", "..", "templates", "skills", "wip-coordinate", "SKILL.md"),
      "utf8",
    );
    const from = skill.indexOf("**Start command.**");
    expect(from).toBeGreaterThan(-1);
    const paragraph = skill.slice(from, skill.indexOf("\n\n", from));
    expect(paragraph).toContain(defaultStart().join(" "));
  });
});

describe("modes", () => {
  test("set validates and saves, show and dry-run expand without saving, unset removes", () => {
    const set = startMode("set", ["claude", "--name", "wip-{stamp}"], project, {});
    expect(set.data.start).toEqual(["claude", "--name", "wip-{stamp}"]);
    expect(raw().start).toEqual(["claude", "--name", "wip-{stamp}"]);
    expect(() => startMode("set", ["{nope}"], project, {})).toThrow(/unknown variable/);
    expect(raw().start).toEqual(["claude", "--name", "wip-{stamp}"]);

    const shown = startMode("show", [], project, {});
    expect(shown.data.origin).toBe("config");
    const dry = startMode("dry-run", ["--resume"], project, {});
    expect((dry.data.argv as string[]).slice(-1)).toEqual(["--resume"]);

    const unset = startMode("unset", [], project, {});
    expect(raw()).not.toHaveProperty("start");
    expect(unset.data.fallback).toEqual(defaultStart());
    expect(unset.lines[0]).toContain("the default:");
  });
});

describe("bare wip and explicit start", () => {
  test("bare wip launches only in a terminal with a project, and never inside a wip session", () => {
    put({ defs_dir: ".claude" });
    expect(isStartLaunch([], {}, true, project)).toBe(true);
    expect(isStartLaunch([], {}, false, project)).toBe(false);
    expect(isStartLaunch([], { WIP_START: "x" }, true, project)).toBe(false);
    expect(isStartLaunch([], {}, true, tmpdir())).toBe(false);
    // A project on a legacy folder still has the default command, so it launches.
    put({ defs_dir: ".agents" });
    expect(isStartLaunch([], {}, true, project)).toBe(true);
  });

  test("explicit start launches unless it is help or a mode that does not launch", () => {
    expect(isStartLaunch(["start"], {}, false, project)).toBe(true);
    expect(isStartLaunch(["start", "--", "--resume"], {}, false, project)).toBe(true);
    expect(isStartLaunch(["start", "--help"], {}, false, project)).toBe(false);
    expect(isStartLaunch(["start", "--dry-run"], {}, false, project)).toBe(false);
    expect(isStartLaunch(["start", "--set", "--", "x"], {}, false, project)).toBe(false);
    expect(isStartLaunch(["check"], {}, false, project)).toBe(false);
  });

  test("the session name stamp of a launch is local time", () => {
    expect(startStamp(new Date(2026, 0, 2, 3, 4))).toBe("26-01-02-03-04");
  });
});

describe("launchBin", () => {
  test("the launcher's path wins; a relative one is resolved against cwd, never realpath'd", () => {
    expect(launchBin({ WIP_LAUNCH_BIN: "/x/bin/wip2" }, "/opt/wip", "/w")).toBe("/x/bin/wip2");
    expect(launchBin({ WIP_LAUNCH_BIN: "bin/wip2" }, "/opt/wip", "/w")).toBe("/w/bin/wip2");
  });

  test("an empty launcher value is ignored", () => {
    expect(launchBin({ WIP_LAUNCH_BIN: "  " }, "/opt/wip", "/w")).toBe("/opt/wip");
  });

  test("without a launcher, a standalone execPath is recorded", () => {
    expect(launchBin({}, "/opt/wip/wip", "/w")).toBe("/opt/wip/wip");
  });

  test("bun or node (a dev run) records nothing", () => {
    expect(launchBin({}, "/Users/x/.bun/bin/bun", "/w")).toBeNull();
    expect(launchBin({}, "/usr/local/bin/node", "/w")).toBeNull();
  });
});

describe("syncWipBin", () => {
  test("sets wip_bin when unset and keeps the other keys", () => {
    put({ defs_dir: ".agents", start: ["x"] });
    expect(syncWipBin(project, "/x/wip2")).toEqual({
      changed: true,
      from: null,
      to: "/x/wip2",
      warning: null,
    });
    expect(raw()).toMatchObject({
      wip_bin: "/x/wip2",
      start: ["x"],
      defs_dir: ".agents",
    });
  });

  test("is silent and leaves the file alone when the value is equal", () => {
    put({ defs_dir: ".claude", wip_bin: "/x/wip2" });
    const before = readFileSync(configPath(project), "utf8");
    expect(syncWipBin(project, "/x/wip2")).toEqual({
      changed: false,
      from: "/x/wip2",
      to: "/x/wip2",
      warning: null,
    });
    expect(readFileSync(configPath(project), "utf8")).toBe(before);
  });

  test("overwrites a different value", () => {
    put({ defs_dir: ".claude", wip_bin: "/old" });
    expect(syncWipBin(project, "/new")).toEqual({
      changed: true,
      from: "/old",
      to: "/new",
      warning: null,
    });
    expect(raw().wip_bin).toBe("/new");
  });

  test("a read-only .wip/ returns a warning and does not throw", () => {
    put({ defs_dir: ".claude" });
    chmodSync(join(project, ".wip"), 0o555);
    try {
      const sync = syncWipBin(project, "/x/wip2");
      expect(sync.changed).toBe(false);
      expect(sync.warning).not.toBeNull();
    } finally {
      chmodSync(join(project, ".wip"), 0o755);
    }
    expect(raw().wip_bin).toBeUndefined();
  });

  test("an invalid config is not overwritten: a warning and the file unchanged", () => {
    put({ defs_dir: 5 });
    const before = readFileSync(configPath(project), "utf8");
    const sync = syncWipBin(project, "/x/wip2");
    expect(sync.changed).toBe(false);
    expect(sync.warning).toContain("defs_dir");
    expect(readFileSync(configPath(project), "utf8")).toBe(before);
  });
});

describe("childWipBin", () => {
  test("a stored absolute value is returned as it is, whatever was launched", () => {
    put({ defs_dir: ".claude", wip_bin: "/x/wip2" });
    expect(childWipBin(project, "/launched/wip2")).toBe("/x/wip2");
    expect(childWipBin(project, null)).toBe("/x/wip2");
  });

  test("a stored relative value is resolved against the project root, never realpath'd", () => {
    put({ defs_dir: ".claude", wip_bin: "bin/wip" });
    expect(childWipBin(project, null)).toBe(join(project, "bin", "wip"));
  });

  test("a stored ~/ value is expanded to the home folder", () => {
    put({ defs_dir: ".claude", wip_bin: "~/bin/wip" });
    expect(childWipBin(project, null)).toBe(join(homedir(), "bin", "wip"));
  });

  test("without a readable stored value, the launched path is used", () => {
    put({ defs_dir: ".claude" });
    expect(childWipBin(project, "/launched/wip2")).toBe("/launched/wip2");
    writeFileSync(configPath(project), "{");
    expect(childWipBin(project, "/launched/wip2")).toBe("/launched/wip2");
  });

  test("neither a stored value nor a launch path gives null (the PATH is used)", () => {
    put({ defs_dir: ".claude" });
    expect(childWipBin(project, null)).toBeNull();
  });
});
