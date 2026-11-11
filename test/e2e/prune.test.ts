import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WIP_CMD } from "../helpers/bin.ts";
import { files, put } from "../helpers/prune-fixture.ts";

// End-to-end `wip prune` and `wip archive` (prune by default): the real CLI entry point in a child process, in a temp
// project, with a fake trash command in WIP_TRASH_CMD (never the real Trash, never this repo's .wip/).
// Ports cases 1-18, 20 and 21 of the QA plan (.wip/items/development/prune-cmd/qa-plan.md). Case 19, the real macOS
// /usr/bin/trash, stays manual: it puts a folder in the user's Trash.

const CLI = join(import.meta.dir, "..", "..", "src", "main.ts");
const FULL_RE = /^PRUNE · Trash wip-prune-(\d+) /m;

let base: string; // holds the template, the fake trash scripts and one project per test
let proj: string;
let home: string;
let trashLog: string;
let trashDir: string;
let okTrash: string;

const FAKE_TRASH = (dir: string) => `#!/bin/sh
# Fake trash for WIP_TRASH_CMD: logs its arguments and moves what it gets to ${dir}/fake-trash/.
# FAKE_TRASH_FAIL=1 makes it fail (exit 1) without moving anything.
echo "args($#): $*" >> "${dir}/trash.log"
if [ "$FAKE_TRASH_FAIL" = "1" ]; then echo "fake trash: forced failure" >&2; exit 1; fi
mkdir -p "${dir}/fake-trash"
for src in "$@"; do
  dest="${dir}/fake-trash/$(basename "$src")"; n=1
  while [ -e "$dest" ]; do n=$((n+1)); dest="${dir}/fake-trash/$(basename "$src")-dup$n"; done
  mv "$src" "$dest"
done
`;

interface IOut {
  code: number;
  stdout: string;
  stderr: string;
}

/** The real CLI in a child process with a clean environment (WIP_TRASH_CMD is the fake trash unless `env` says so). */
function wip(argv: string[], env: Record<string, string> = {}, cwd = proj): IOut {
  const cmd = WIP_CMD ?? [process.execPath, CLI];
  const proc = Bun.spawnSync([...cmd, ...argv], {
    cwd,
    stdin: "ignore",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, WIP_TRASH_CMD: okTrash, ...env },
  });
  return {
    code: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

const ok = (argv: string[], env: Record<string, string> = {}, cwd = proj): IOut => {
  const out = wip(argv, env, cwd);
  if (out.code !== 0)
    throw new Error(`wip ${argv.join(" ")} → ${out.code}: ${out.stderr}${out.stdout}`);
  return out;
};

/** The fixture of the review environment (tmp/review/new-case.sh): one file per rule plus what has to stay. */
function fill(project: string, flow: string, id: string): void {
  const d = join(project, ".wip", "items", flow, id);
  put(
    join(d, "plan.md"),
    "# Plan\n\nEvidence: see tmp/cited-shot.png and tmp/notes/cited.txt.\nOther: ![x](cited-name-longer.png)\n",
  );
  put(join(d, "root-file.txt"), "root file, must stay\n");
  put(join(d, ".DS_Store"), "root DS_Store, must stay\n");
  put(
    join(d, "prune-expect.txt"),
    "expectation: prune.md exists at the item root after a real prune\n",
  );
  put(join(d, "sub/doc.md"), "doc in subfolder, must stay\n");
  put(join(d, "sub/__pycache__/m.pyc"), "pyc in sub, D5\n");
  put(join(d, "gifs/keep.gif"), "gif root dir, must stay\n");
  put(join(d, "_backup/old.md"), "backup, must stay\n");
  put(join(d, "tmp/cited-shot.png"), "PNGDATA");
  put(join(d, "tmp/cited-name-longer.png"), "PNGDATA");
  put(join(d, "tmp/notes/cited.txt"), "cited text\n");
  put(join(d, "tmp/uncited.txt"), "uncited scratch\n");
  put(join(d, "tmp/uncited.png"), "PNGDATA");
  put(join(d, "tmp/sub/deep.txt"), "x\n");
  put(join(d, "tmp/app.sqlite"), "db\n");
  put(join(d, "tmp/node_modules/pkg/index.js"), "pkg\n");
  put(join(d, "node_modules/rootpkg/index.js"), "pkg\n");
  put(join(d, "tmp/chrome-profile-x/Default/Login Data"), "login\n");
  put(join(d, "tmp/chrome-profile-x/Local State"), "state\n");
  put(join(d, "chrome-prof-root/Default/Login Data"), "root profile\n");
  const binary = (magic: string, kb: number): Buffer => {
    const b = Buffer.alloc(kb * 1024 + 4);
    Buffer.from(magic, "hex").copy(b);
    return b;
  };
  put(join(d, "tmp/fake-binary"), binary("cffaedfe", 1200)); // Mach-O, 1.2 MB: D2
  put(join(d, "tmp/fake-elf"), binary("7f454c46", 1100)); // ELF, 1.1 MB: D2
  put(join(d, "tmp/small-binary"), binary("cffaedfe", 10)); // < 1 MB: not D2, falls to D7
}

/** What a full prune removes from an item folder (relative to it) and what must stay. */
const PRUNED = [
  "tmp/fake-binary",
  "tmp/fake-elf",
  "tmp/node_modules/pkg/index.js",
  "tmp/chrome-profile-x/Default/Login Data",
  "tmp/chrome-profile-x/Local State",
  "sub/__pycache__/m.pyc",
  "tmp/app.sqlite",
  "tmp/small-binary",
  "tmp/uncited.txt",
  "tmp/uncited.png",
  "tmp/sub/deep.txt",
];
const STAYS = [
  "plan.md",
  "root-file.txt",
  ".DS_Store",
  "prune-expect.txt",
  "sub/doc.md",
  "gifs/keep.gif",
  "_backup/old.md",
  "tmp/cited-shot.png",
  "tmp/cited-name-longer.png",
  "tmp/notes/cited.txt",
  "node_modules/rootpkg/index.js",
  "chrome-prof-root/Default/Login Data",
];

const ITEMS = [
  ["tasks", "A1"],
  ["notes", "A2"],
  ["tasks", "O1"],
  ["tasks", "N1"],
  ["tasks", "N2"],
] as const;

const dirOf = (flow: string, id: string): string => join(proj, ".wip", "items", flow, id);
const A1 = (): string => dirOf("tasks", "A1");
const lines = (path: string): string[] =>
  existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
const staging = (): string[] =>
  existsSync(join(proj, ".wip", "tmp")) ? readdirSync(join(proj, ".wip", "tmp")).sort() : [];
const trashed = (): string[] =>
  existsSync(join(trashDir, "fake-trash")) ? readdirSync(join(trashDir, "fake-trash")).sort() : [];
const stamp = (out: IOut): string => {
  const m = FULL_RE.exec(out.stdout);
  if (m === null) throw new Error(`no staging stamp in: ${out.stdout}`);
  return `wip-prune-${m[1]}`;
};
// biome-ignore lint/suspicious/noExplicitAny: parsed JSON read by assertions
const json = (out: IOut): Record<string, any> => JSON.parse(out.stdout);

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "wip-prune-e2e-")));
  home = join(base, "home");
  mkdirSync(home);
  trashDir = join(base, "trash");
  mkdirSync(trashDir);
  trashLog = join(trashDir, "trash.log");
  okTrash = join(trashDir, "fake-trash.sh");
  writeFileSync(okTrash, FAKE_TRASH(trashDir));
  chmodSync(okTrash, 0o755);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

/** A project made by `wip init`, a second flow `notes`, A1 and A2 archived, O1 N1 N2 open, each with the fixture. */
function makeProject(dir: string): void {
  mkdirSync(dir);
  ok(["init", "--yes", "."], {}, dir);
  writeFileSync(join(dir, "outside.txt"), "outside target\n");
  const tasksFlow = join(dir, ".claude", "skills", "wip-flow-tasks");
  const notesFlow = join(dir, ".claude", "skills", "wip-flow-notes");
  cpSync(tasksFlow, notesFlow, { recursive: true });
  const skill = join(notesFlow, "SKILL.md");
  writeFileSync(
    skill,
    readFileSync(skill, "utf8")
      .replaceAll("wip-flow-tasks", "wip-flow-notes")
      .replace(/^# tasks/m, "# notes"),
  );
  for (const [flow, id] of ITEMS) {
    ok(["phase", id, "todo", "--flow", flow], {}, dir);
    fill(dir, flow, id);
    // A symlink in tmp/ to a file outside the item: never followed, never removed.
    symlinkSync(
      join(dir, "outside.txt"),
      join(dir, ".wip", "items", flow, id, "tmp", "link-to-outside"),
    );
  }
  ok(["archive", "A1", "--no-prune"], {}, dir);
  ok(["archive", "A2", "--no-prune"], {}, dir);
}

beforeEach(() => {
  // A fresh project per test (the database records absolute paths, so it is built, not copied), and a clean fake trash.
  proj = join(base, `case-${Math.random().toString(36).slice(2)}`);
  rmSync(trashDir, { recursive: true, force: true });
  mkdirSync(trashDir);
  writeFileSync(okTrash, FAKE_TRASH(trashDir));
  chmodSync(okTrash, 0o755);
  makeProject(proj);
});

const snapshot = (dir: string): string[] => files(dir);
const showA1 = (): string => ok(["show", "A1"]).stdout;

describe("wip prune (e2e)", () => {
  test("1 dry run: reports every rule, changes nothing", () => {
    const before = snapshot(A1());
    const out = wip(["prune", "A1", "--dry-run"]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("PRUNE --dry-run");
    for (const rule of ["D2", "D3", "D4", "D5", "D6", "D7"])
      expect(out.stdout).toMatch(new RegExp(`^\\s+${rule} `, "m"));
    expect(out.stdout).toMatch(/R1|R2/);
    expect(out.stdout).toContain("A1 · kept at the root: chrome-prof-root/ (browser profile)");
    expect(out.stdout).toContain("TOTAL");
    expect(snapshot(A1())).toEqual(before);
    expect(existsSync(join(A1(), "prune.md"))).toBe(false);
    expect(showA1()).not.toContain("pruned");
    expect(staging()).toEqual([]);
    expect(existsSync(trashLog)).toBe(false);
  });

  test("2 real prune of one item", () => {
    const out = wip(["prune", "A1"]);
    expect(out.code).toBe(0);
    const name = stamp(out);
    for (const f of PRUNED) expect(existsSync(join(A1(), f))).toBe(false);
    for (const f of STAYS) expect(existsSync(join(A1(), f))).toBe(true);
    expect(existsSync(join(A1(), "prune.md"))).toBe(true);
    expect(showA1()).toMatch(/milestone · pruned: 2\.\d MB in 11 files \(trash\)/);
    const log = lines(trashLog);
    expect(log).toHaveLength(1);
    expect(log[0]).toContain(join(proj, ".wip", "tmp", name));
    const got = files(join(trashDir, "fake-trash", name, "tasks", "A1"));
    expect(got).toEqual([...PRUNED].sort());
    expect(staging()).toEqual([]);
    expect(ok(["check"]).code).toBe(0);
  });

  test("3 rerun with nothing new: prune.md keeps its entries, no second event or trash call", () => {
    ok(["prune", "A1"]);
    const first = readFileSync(join(A1(), "prune.md"), "utf8");
    const out = wip(["prune", "A1"]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("0 items");
    expect(out.stdout).toContain("0.0 MB");
    expect(out.stdout).toContain("A1 · kept at the root: chrome-prof-root/ (browser profile)");
    const md = readFileSync(join(A1(), "prune.md"), "utf8");
    expect(md).toMatch(/- Date: .+ \(rerun, nothing new to prune; first run .+\)/);
    for (const f of ["tmp/uncited.txt", "tmp/fake-binary", "sub/__pycache__/"])
      expect(md).toContain(f);
    expect(md.split("\n").slice(4)).toEqual(first.split("\n").slice(4));
    expect(showA1().match(/milestone · pruned/g)).toHaveLength(1);
    expect(lines(trashLog)).toHaveLength(1);
    for (const f of ["tmp/cited-shot.png", "tmp/notes/cited.txt"])
      expect(existsSync(join(A1(), f))).toBe(true);
  });

  test("4 --archived: dry run lists A1 and A2 only, the real run uses one staging folder", () => {
    const dry = wip(["prune", "--archived", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain("A1 · tasks");
    expect(dry.stdout).toContain("A2 · notes");
    for (const open of ["O1", "N1", "N2"]) expect(dry.stdout).not.toContain(`${open} ·`);
    expect(existsSync(trashLog)).toBe(false);

    const out = wip(["prune", "--archived"]);
    expect(out.code).toBe(0);
    const name = stamp(out);
    expect(lines(trashLog)).toHaveLength(1);
    expect(trashed()).toEqual([name]);
    expect(readdirSync(join(trashDir, "fake-trash", name)).sort()).toEqual(["notes", "tasks"]);
    for (const [flow, id] of [
      ["tasks", "A1"],
      ["notes", "A2"],
    ]) {
      const d = dirOf(flow as string, id as string);
      expect(readFileSync(join(d, "prune.md"), "utf8")).toContain(
        `Destination: trash: ${name}/${flow}/${id}/`,
      );
      expect(ok(["show", id as string]).stdout).toContain("milestone · pruned");
      expect(existsSync(join(d, "tmp", "uncited.txt"))).toBe(false);
    }
    expect(existsSync(join(dirOf("tasks", "N1"), "tmp", "uncited.txt"))).toBe(true);
  });

  test("5 --archived --flow notes prunes only A2", () => {
    const out = wip(["prune", "--archived", "--flow", "notes"]);
    expect(out.code).toBe(0);
    expect(existsSync(join(dirOf("notes", "A2"), "prune.md"))).toBe(true);
    expect(existsSync(join(dirOf("notes", "A2"), "tmp", "uncited.txt"))).toBe(false);
    expect(existsSync(join(A1(), "prune.md"))).toBe(false);
    expect(existsSync(join(A1(), "tmp", "uncited.txt"))).toBe(true);
  });

  test("6 --keep keeps D7 paths, never a D4 profile; a relative --keep with --archived", () => {
    const keep = "tmp/uncited.txt,tmp/sub";
    const dry = wip(["prune", "A1", "--keep", keep, "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(existsSync(join(A1(), "tmp", "uncited.txt"))).toBe(true);
    const out = wip(["prune", "A1", "--keep", keep]);
    expect(out.code).toBe(0);
    expect(existsSync(join(A1(), "tmp/uncited.txt"))).toBe(true);
    expect(existsSync(join(A1(), "tmp/sub/deep.txt"))).toBe(true);
    expect(existsSync(join(A1(), "tmp/uncited.png"))).toBe(false);
    expect(existsSync(join(A1(), "tmp/small-binary"))).toBe(false);
    const md = readFileSync(join(A1(), "prune.md"), "utf8");
    expect(md).toContain("tmp/uncited.txt");
    expect(md).toContain("tmp/sub");
    expect(md).toMatch(/kept/i);
  });

  test("6b --keep of a D4 profile does not save it", () => {
    ok(["prune", "A2", "--keep", "tmp/chrome-profile-x"]);
    expect(existsSync(join(dirOf("notes", "A2"), "tmp", "chrome-profile-x"))).toBe(false);
  });

  test("6c --archived with a relative --keep is a usage error (exit 2), nothing pruned", () => {
    const out = wip(["prune", "--archived", "--keep", "tmp/uncited.txt"]);
    expect(out.code).toBe(2);
    expect(existsSync(join(A1(), "tmp", "uncited.txt"))).toBe(true);
    expect(existsSync(trashLog)).toBe(false);
  });

  test("7 --report: absolute is written (also with --dry-run), relative is a usage error", () => {
    const report = join(base, "prune-report.md");
    const dry = wip(["prune", "A1", "--dry-run", "--report", report]);
    expect(dry.code).toBe(0);
    expect(existsSync(report)).toBe(true);
    expect(readFileSync(report, "utf8")).toContain("A1");
    expect(existsSync(join(A1(), "prune.md"))).toBe(false);
    expect(existsSync(join(A1(), "tmp", "uncited.txt"))).toBe(true);
    rmSync(report);
    ok(["prune", "A1", "--report", report]);
    expect(existsSync(report)).toBe(true);

    const rel = wip(["prune", "A2", "--report", "rel.md"]);
    expect(rel.code).toBe(2);
    expect(existsSync(join(proj, "rel.md"))).toBe(false);
    expect(existsSync(join(dirOf("notes", "A2"), "tmp", "uncited.txt"))).toBe(true);
  });

  test("8 --json: one envelope on stdout, dry run and real", () => {
    const dry = wip(["prune", "A1", "--dry-run", "--json"]);
    expect(dry.code).toBe(0);
    const d = json(dry);
    expect(d.ok).toBe(true);
    expect(d.data.dry_run).toBe(true);
    expect(Object.keys(d.data).sort()).toEqual([
      "dry_run",
      "items",
      "retried",
      "staged",
      "totals",
      "trash",
    ]);
    const item = d.data.items[0];
    for (const k of ["id", "flow", "artifact_dir", "bytes", "files", "entries"])
      expect(item).toHaveProperty(k);
    expect(item.id).toBe("A1");
    expect(Array.isArray(item.entries)).toBe(true);
    expect(existsSync(trashLog)).toBe(false);

    const real = wip(["prune", "A1", "--json"]);
    expect(real.code).toBe(0);
    const r = json(real);
    expect(r.ok).toBe(true);
    expect(r.data.dry_run).toBe(false);
    expect(r.data.trash).toMatch(/wip-prune-/);
  });

  test("9 an open item is rejected; unknown id; usage errors", () => {
    const before = snapshot(dirOf("tasks", "O1"));
    for (const argv of [
      ["prune", "O1"],
      ["prune", "O1", "--dry-run"],
    ]) {
      const out = wip(argv);
      expect(out.code).toBe(3);
      expect(out.stderr).toContain("wip: O1 is open: it is not pruned");
    }
    expect(snapshot(dirOf("tasks", "O1"))).toEqual(before);
    expect(wip(["prune", "ZZ"]).code).toBe(4);
    expect(wip(["prune"]).code).toBe(2);
    expect(wip(["prune", "A1", "--archived"]).code).toBe(2);
    expect(existsSync(trashLog)).toBe(false);
  });

  test("10 no trash command: nothing is pruned, dry run still works", () => {
    const before = snapshot(A1());
    const out = wip(["prune", "A1"], { WIP_TRASH_CMD: "/nonexistent" });
    expect(out.code).toBe(3);
    expect(out.stderr).toContain("no trash command: nothing is pruned (set WIP_TRASH_CMD");
    expect(snapshot(A1())).toEqual(before);
    expect(existsSync(join(A1(), "prune.md"))).toBe(false);
    expect(showA1()).not.toContain("pruned");
    expect(wip(["prune", "A1", "--dry-run"], { WIP_TRASH_CMD: "/nonexistent" }).code).toBe(0);
  });

  test("11 trash failure: staged in .wip/tmp, no event, prune.md says so", () => {
    const out = wip(["prune", "A1"], { FAKE_TRASH_FAIL: "1" });
    expect(out.code).toBe(1);
    expect(out.stdout).toContain("PRUNE · Trash failed (staged in .wip/tmp)");
    const [name] = staging();
    expect(staging()).toHaveLength(1);
    expect(name).toMatch(/^wip-prune-/);
    const dir = join(proj, ".wip", "tmp", name as string);
    expect(out.stdout).toContain(`ERROR ${dir} · trash-failed`);
    expect(out.stdout).toContain(`STAGED ${dir} · the trash failed`);
    expect(out.stdout + out.stderr).toContain("the trash failed; what was pruned is in");
    expect(files(join(dir, "tasks", "A1"))).toEqual([...PRUNED].sort());
    expect(existsSync(join(A1(), "tmp", "uncited.txt"))).toBe(false);
    expect(showA1()).not.toContain("milestone · pruned");
    expect(readFileSync(join(A1(), "prune.md"), "utf8")).toMatch(
      /Destination: .*\(the trash failed: it stays in \.wip\/tmp\)/,
    );
    expect(lines(trashLog)).toHaveLength(1);
    expect(trashed()).toEqual([]);
  });

  test("16 and 17 root entries stay; prune.md has its sections and survives a rerun", () => {
    const dry = wip(["prune", "A1", "--dry-run"]);
    expect(dry.stdout).toContain("A1 · kept at the root: chrome-prof-root/ (browser profile)");
    const out = wip(["prune", "A1"]);
    expect(out.stdout).toContain("A1 · kept at the root: chrome-prof-root/ (browser profile)");
    const root = readdirSync(A1()).sort();
    for (const f of [
      "node_modules",
      "chrome-prof-root",
      ".DS_Store",
      "root-file.txt",
      "_backup",
      "gifs",
      "plan.md",
      "prune-expect.txt",
    ])
      expect(root).toContain(f);
    expect(readFileSync(join(A1(), "node_modules/rootpkg/index.js"), "utf8")).toBe("pkg\n");
    expect(readdirSync(join(A1(), "chrome-prof-root", "Default"))).toEqual(["Login Data"]);
    expect(readdirSync(join(A1(), "sub"))).toEqual(["doc.md"]);

    const md = readFileSync(join(A1(), "prune.md"), "utf8");
    for (const part of [
      "Date:",
      "Destination:",
      "Total:",
      "### Rescues (kept)",
      "### Kept at the root (browser profile)",
      "chrome-prof-root/",
      "chrome-profile-x",
    ])
      expect(md).toContain(part);
    for (const f of ["tmp/uncited.txt", "tmp/fake-binary", "tmp/app.sqlite"])
      expect(md).toContain(f);
    const date = /- Date: (\S+)/.exec(md)?.[1];

    Bun.sleepSync(1100);
    ok(["prune", "A1"]);
    const again = readFileSync(join(A1(), "prune.md"), "utf8");
    expect(again).toContain(`(rerun, nothing new to prune; first run ${date})`);
    for (const f of [
      "tmp/uncited.txt",
      "tmp/fake-binary",
      "tmp/app.sqlite",
      "### Rescues (kept)",
      "### Kept at the root (browser profile)",
    ])
      expect(again).toContain(f);
  });

  test("18 a symlink in tmp/ and its target survive, and the link is not listed", () => {
    ok(["prune", "A1"]);
    const link = join(A1(), "tmp", "link-to-outside");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(proj, "outside.txt"), "utf8")).toBe("outside target\n");
    expect(readFileSync(join(A1(), "prune.md"), "utf8")).not.toContain("link-to-outside");
    expect(files(join(trashDir, "fake-trash"))).not.toContain("link-to-outside");
  });

  test("20 retry of leftover staging by a later wip prune", () => {
    const failed = wip(["prune", "A1"], { FAKE_TRASH_FAIL: "1" });
    expect(failed.code).toBe(1);
    const [name] = staging();
    expect(staging()).toHaveLength(1);

    // the trash still fails: exit 1, warning, the staging stays, no event
    const again = wip(["prune", "A1"], { FAKE_TRASH_FAIL: "1" });
    expect(again.code).toBe(1);
    expect(again.stdout + again.stderr).toContain("the trash failed again for");
    expect(staging()).toEqual([name as string]);
    expect(showA1()).not.toContain("milestone · pruned");

    const out = wip(["prune", "A1"]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("PRUNE · Trash (only leftovers retried) · 0 items");
    expect(out.stdout).toContain(`RETRY ${name} · sent to the trash`);
    expect(staging()).toEqual([]);
    expect(trashed()).toEqual([name as string]);
    expect(showA1()).toMatch(/milestone · pruned: 2\.\d MB in 11 files \(trash, retried\)/);
    const md = readFileSync(join(A1(), "prune.md"), "utf8");
    expect(md).toContain(`Destination: trash: ${name} (retried by a later wip prune)`);
  });

  test("21 --json staged and retried", () => {
    const keys = ["dry_run", "items", "retried", "staged", "totals", "trash"];
    const dry = json(wip(["prune", "A1", "--dry-run", "--json"]));
    expect(Object.keys(dry.data).sort()).toEqual(keys);
    expect(dry.data.trash).toBeNull();
    expect(dry.data.staged).toEqual([]);
    expect(dry.data.retried).toEqual([]);

    const failed = wip(["prune", "A1", "--json"], { FAKE_TRASH_FAIL: "1" });
    expect(failed.code).toBe(1);
    const f = json(failed);
    expect(f.ok).toBe(false);
    expect(f.data.trash).toBeNull();
    const [name] = staging();
    expect(f.data.staged).toEqual([join(proj, ".wip", "tmp", name as string)]);
    expect(f.warnings.map((w: { code: string }) => w.code)).toContain("prune");
    expect(Object.keys(f.data).sort()).toEqual(keys);
    expect(f.data.items[0].root_kept).toEqual(["chrome-prof-root/"]);

    const next = wip(["prune", "A1", "--json"]);
    expect(next.code).toBe(0);
    const n = json(next);
    expect(n.ok).toBe(true);
    expect(n.data.staged).toEqual([]);
    expect(n.data.retried).toEqual([name as string]);
  });
});

describe("wip archive prunes by default (e2e)", () => {
  const N1 = (): string => dirOf("tasks", "N1");

  test("12 archive prunes by default", () => {
    const out = wip(["archive", "N1"]);
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/N1 · archived in todo · pruned 2\.\d MB \(trash\)/);
    for (const f of PRUNED) expect(existsSync(join(N1(), f))).toBe(false);
    for (const f of STAYS) expect(existsSync(join(N1(), f))).toBe(true);
    expect(existsSync(join(N1(), "prune.md"))).toBe(true);
    expect(ok(["show", "N1"]).stdout).toContain("milestone · pruned");
    expect(lines(trashLog)).toHaveLength(1);
  });

  test("13 archive --no-prune leaves the folder, a later prune works", () => {
    const out = wip(["archive", "N2", "--no-prune"]);
    expect(out.code).toBe(0);
    const n2 = dirOf("tasks", "N2");
    expect(existsSync(join(n2, "tmp", "uncited.txt"))).toBe(true);
    expect(existsSync(join(n2, "prune.md"))).toBe(false);
    expect(ok(["show", "N2"]).stdout).not.toContain("pruned");
    expect(existsSync(trashLog)).toBe(false);
    expect(wip(["prune", "N2"]).code).toBe(0);
    expect(existsSync(join(n2, "tmp", "uncited.txt"))).toBe(false);
    expect(existsSync(join(n2, "prune.md"))).toBe(true);
  });

  test("14 archive with no trash command: archived, warning, folder untouched, prune works later", () => {
    const before = snapshot(N1());
    const out = wip(["archive", "N1"], { WIP_TRASH_CMD: "/nonexistent" });
    expect(out.code).toBe(0);
    expect(out.stdout + out.stderr).toContain("no prune: no trash command (set WIP_TRASH_CMD");
    expect(ok(["show", "N1"]).stdout).toContain("archived");
    expect(snapshot(N1())).toEqual(before);
    expect(wip(["prune", "N1"]).code).toBe(0);
    expect(existsSync(join(N1(), "tmp", "uncited.txt"))).toBe(false);
  });

  test("15 archive with a failing trash exits 0; a later prune retries the staging", () => {
    const out = wip(["archive", "N1"], { FAKE_TRASH_FAIL: "1" });
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(
      /N1 · archived in todo · not pruned: 2\.\d MB moved to \.wip\/tmp, the trash failed/,
    );
    expect(out.stdout).not.toContain("(trash)");
    const all = out.stdout + out.stderr;
    expect(all).toContain(join(proj, ".wip", "tmp", "wip-prune-"));
    expect(all).toContain("repeat with wip prune N1");
    expect(staging()).toHaveLength(1);
    expect(ok(["show", "N1"]).stdout).not.toContain("milestone · pruned");

    const [name] = staging();
    const retry = wip(["prune", "N1"]);
    expect(retry.code).toBe(0);
    expect(retry.stdout).toContain(`RETRY ${name} · sent to the trash`);
    expect(staging()).toEqual([]);
    expect(trashed()).toEqual([name as string]);
    expect(ok(["show", "N1"]).stdout).toContain("(trash, retried)");
  });
});
