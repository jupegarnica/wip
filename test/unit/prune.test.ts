import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { EXIT } from "../../src/errors.ts";
import { itemInPlan, itemsProject, useProject } from "../helpers/items.ts";
import { count, type IQueryable } from "../helpers/project.ts";
import {
  archivedItem,
  fakeTrash,
  files,
  fixture,
  jsonWithTrash,
  KEPT,
  put,
  withTrash,
} from "../helpers/prune-fixture.ts";

const ctx = useProject();

function setDir(dbPath: string, id: string, dir: string): void {
  const db = new Database(dbPath);
  db.query("UPDATE items SET artifact_dir = ? WHERE id = ?").run(dir, id);
  db.close();
}

const prunedEvents = (db: IQueryable): number =>
  count(db, "SELECT count(*) AS n FROM events WHERE json_extract(data, '$.name') = 'pruned'");

describe("wip prune", () => {
  test("--dry-run lists D1-D7 and the rescues without moving or recording anything", () => {
    const p = ctx.set(itemsProject("prune-dry"));
    const dir = archivedItem(p);
    fixture(dir);
    const before = files(dir);
    const out = p.wip(["prune", "T1", "--dry-run"], { env: {} });
    expect(out.code).toBe(0);
    for (const r of ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "R1", "R2"]) {
      expect(out.stdout).toContain(`  ${r} `);
    }
    expect(out.stdout).toContain("PRUNE --dry-run · Trash");
    expect(files(dir)).toEqual(before);
    const json = JSON.parse(p.wip(["prune", "T1", "--dry-run", "--json"], { env: {} }).stdout);
    expect(json.events).toEqual([]);
    expect(Object.keys(json.data).sort()).toEqual([
      "dry_run",
      "items",
      "retried",
      "staged",
      "totals",
      "trash",
    ]);
    const item = json.data.items[0];
    expect(
      item.entries.map((e: { rule: string; path: string }) => `${e.rule} ${e.path}`).sort(),
    ).toEqual([
      "D1 tmp/storybook-static",
      "D2 tmp/fake-macho",
      "D3 tmp/lh/node_modules",
      "D4 tmp/p/chrome-prof",
      "D5 sub/__pycache__",
      "D6 tmp/copy.sqlite",
      "D7 tmp/lh",
      "D7 tmp/p",
      "D7 tmp/probe.ts",
    ]);
    expect(item.entries.find((e: { rule: string }) => e.rule === "D2").sha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(
      item.rescued.map(
        (r: { rule: string; path: string; cited_in: string }) =>
          `${r.rule} ${r.path} ${r.cited_in}`,
      ),
    ).toEqual(["R2 tmp/notes.txt cierre.md", "R1 tmp/qa1-evidence.png qa-report.md"]);
    const db = p.db();
    expect(prunedEvents(db)).toBe(0);
    db.close();
  });

  test("--dry-run does not create the database", () => {
    const p = ctx.set(itemsProject("prune-dry-nodb"));
    expect(p.wip(["prune", "--archived", "--dry-run"]).code).toBe(0);
    expect(existsSync(p.dbPath)).toBe(false);
    expect(p.wip(["prune", "T1", "--dry-run"]).code).toBe(EXIT.NOT_FOUND);
    expect(existsSync(p.dbPath)).toBe(false);
  });

  test("a real run stages one wip-prune-<ts> folder, the trash gets it, and the documents stay", () => {
    const p = ctx.set(itemsProject("prune-trash"));
    const t = fakeTrash(p.dir);
    const dir = archivedItem(p);
    fixture(dir);
    const out = jsonWithTrash(p, t.ok, ["prune", "T1"]);
    expect(out.ok).toBe(true);
    expect(files(dir)).toEqual(KEPT);
    const [folder] = readdirSync(t.trash) as [string];
    expect(folder).toMatch(/^wip-prune-\d{14}$/);
    expect(files(join(t.trash, folder))).toEqual([
      "valid/T1/sub/__pycache__/a.pyc",
      "valid/T1/tmp/copy.sqlite",
      "valid/T1/tmp/fake-macho",
      "valid/T1/tmp/lh/node_modules/a",
      "valid/T1/tmp/p/chrome-prof/Default/Login Data",
      "valid/T1/tmp/probe.ts",
      "valid/T1/tmp/storybook-static/x.js",
    ]);
    const ev = out.events[0] as { kind: string; data: Record<string, unknown>; text: string };
    expect(ev.kind).toBe("milestone");
    expect(ev.data.name).toBe("pruned");
    expect(ev.data.trash).toBe(folder);
    expect(Object.keys(ev.data.rules as object).sort()).toEqual([
      "D1",
      "D2",
      "D3",
      "D4",
      "D5",
      "D6",
      "D7",
    ]);
    expect(ev.data.errors).toEqual([]);
    const md = readFileSync(join(dir, "prune.md"), "utf8");
    expect(md).toContain(`trash: ${folder}/valid/T1/`);
    expect(md).toContain("browser profiles");
    expect(md).toContain("cited in qa-report.md");
    expect(files(join(p.dir, ".wip", "tmp"))).toEqual([]);
    expect(p.wip(["check"]).code).toBe(0);
  });

  test("every root entry other than tmp/ stays; D3 and D5 still apply inside root folders", () => {
    const p = ctx.set(itemsProject("prune-root"));
    const t = fakeTrash(p.dir);
    const dir = archivedItem(p);
    put(join(dir, "node_modules/keep.js"), "k");
    put(join(dir, "node_modules/pkg/node_modules/inner.js"), "i");
    put(join(dir, "storybook-static/index.html"), "s");
    put(join(dir, ".DS_Store"), "d");
    put(join(dir, "docs/node_modules/a.js"), "a");
    put(join(dir, "docs/note.md"), "# n\n");
    put(join(dir, "gifs/node_modules/a.js"), "g");
    put(join(dir, "evidence/chrome-prof/Default/Login Data"), "");
    put(join(dir, "tmp/x.bin"), "x");
    expect(withTrash(p, t.ok, ["prune", "T1"]).code).toBe(0);
    expect(files(dir)).toEqual([
      ".DS_Store",
      "docs/note.md",
      "gifs/node_modules/a.js",
      "node_modules/keep.js",
      "prune.md",
      "storybook-static/index.html",
    ]);
  });

  test("symbolic links are never followed or moved", () => {
    const p = ctx.set(itemsProject("prune-link"));
    const t = fakeTrash(p.dir);
    const dir = archivedItem(p);
    fixture(dir);
    const target = join(p.dir, "outside.txt");
    writeFileSync(target, "outside\n");
    symlinkSync(target, join(dir, "tmp", "link-out"));
    mkdirSync(join(p.dir, "outside-dir", "storybook-static"), { recursive: true });
    writeFileSync(join(p.dir, "outside-dir", "storybook-static", "y.js"), "y");
    symlinkSync(join(p.dir, "outside-dir"), join(dir, "linked-dir"));
    expect(withTrash(p, t.ok, ["prune", "T1"]).code).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("outside\n");
    expect(existsSync(join(p.dir, "outside-dir", "storybook-static", "y.js"))).toBe(true);
    expect(lstatSync(join(dir, "tmp", "link-out")).isSymbolicLink()).toBe(true);
  });

  test("--keep keeps a tmp/ file but never a browser profile; --archived needs absolute --keep", () => {
    const p = ctx.set(itemsProject("prune-keep"));
    const t = fakeTrash(p.dir);
    const dir = archivedItem(p);
    fixture(dir);
    expect(
      withTrash(p, t.ok, ["prune", "T1", "--keep", "tmp/probe.ts,tmp/p/chrome-prof"]).code,
    ).toBe(0);
    expect(files(dir)).toContain("tmp/probe.ts");
    expect(existsSync(join(dir, "tmp", "p", "chrome-prof"))).toBe(false);
    expect(withTrash(p, t.ok, ["prune", "--archived", "--keep", "tmp/probe.ts"]).code).toBe(
      EXIT.USAGE,
    );
  });

  test("open items, a foreign artifact_dir and another item's folder are refused (3); usage and unknown (2, 4)", () => {
    const p = ctx.set(itemsProject("prune-refuse"));
    const t = fakeTrash(p.dir);
    itemInPlan(p, "T2");
    const open = join(p.dir, ".wip", "items", "valid", "T2");
    fixture(open);
    expect(withTrash(p, t.ok, ["prune", "T2"]).code).toBe(EXIT.REJECTED);
    const outside = join(p.dir, "elsewhere", "T3");
    archivedItem(p, "T3");
    fixture(outside);
    setDir(p.dbPath, "T3", outside);
    expect(withTrash(p, t.ok, ["prune", "T3"]).code).toBe(EXIT.REJECTED);
    expect(files(outside)).toContain("tmp/probe.ts");
    archivedItem(p, "T4");
    setDir(p.dbPath, "T4", open);
    expect(withTrash(p, t.ok, ["prune", "T4"]).code).toBe(EXIT.REJECTED);
    const all = withTrash(p, t.ok, ["prune", "--archived"]);
    expect(all.code).toBe(0);
    expect(all.stdout).toContain("SKIP T4 · folder is not .wip/items/valid/T4");
    expect(all.stdout).toContain("SKIP T3 · folder is not .wip/items/valid/T3");
    expect(files(open)).toContain("tmp/probe.ts");
    expect(p.wip(["prune"]).code).toBe(EXIT.USAGE);
    expect(p.wip(["prune", "T3", "--archived"]).code).toBe(EXIT.USAGE);
    expect(p.wip(["prune", "T3", "--flow", "valid"]).code).toBe(EXIT.USAGE);
    expect(p.wip(["prune", "T1", "--report", "rel.md", "--dry-run"]).code).toBe(EXIT.USAGE);
    expect(p.wip(["prune", "T404", "--dry-run"]).code).toBe(EXIT.NOT_FOUND);
    expect(withTrash(p, t.ok, ["prune", "T404"]).code).toBe(EXIT.NOT_FOUND);
  });

  test("no trash command exits 3 and moves nothing; a failing one leaves everything in .wip/tmp", () => {
    const p = ctx.set(itemsProject("prune-no-trash"));
    const t = fakeTrash(p.dir);
    const dir = archivedItem(p);
    fixture(dir);
    const before = files(dir);
    const refused = withTrash(p, join(p.dir, "missing-trash"), ["prune", "T1"]);
    expect(refused.code).toBe(EXIT.REJECTED);
    expect(refused.stderr).toContain("no trash command");
    expect(files(dir)).toEqual(before);
    const failed = withTrash(p, t.fail, ["prune", "T1"]);
    expect(failed.code).toBe(1);
    const tmp = join(p.dir, ".wip", "tmp");
    const [staging] = readdirSync(tmp) as [string];
    expect(staging).toMatch(/^wip-prune-\d{14}$/);
    expect(failed.stderr).toContain(join(tmp, staging));
    expect(files(join(tmp, staging))).toContain("valid/T1/tmp/probe.ts");
    expect(files(dir)).toEqual(KEPT);
    const db = p.db();
    expect(prunedEvents(db)).toBe(0);
    db.close();
    expect(readFileSync(join(dir, "prune.md"), "utf8")).toContain("the trash failed");
    expect(failed.stdout).toContain("Trash failed");
    expect(failed.stdout).not.toContain("(nothing moved)");
  });

  test("a rerun sends the leftover staging to the trash, records the event and fixes prune.md", () => {
    const p = ctx.set(itemsProject("prune-retry"));
    const t = fakeTrash(p.dir);
    const dir = archivedItem(p);
    fixture(dir);
    expect(withTrash(p, t.fail, ["prune", "T1"]).code).toBe(1);
    const tmp = join(p.dir, ".wip", "tmp");
    const [staging] = readdirSync(tmp) as [string];
    const again = withTrash(p, t.ok, ["prune", "T1"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain(`RETRY ${staging}`);
    expect(readdirSync(tmp)).toEqual([]);
    expect(readdirSync(t.trash)).toEqual([staging]);
    const db = p.db();
    expect(prunedEvents(db)).toBe(1);
    db.close();
    const md = readFileSync(join(dir, "prune.md"), "utf8");
    expect(md).not.toContain("the trash failed");
    expect(md).toContain(`trash: ${staging}`);
    expect(md).toContain("(rerun, nothing new to prune");
  });

  test("a root-level browser profile stays and is reported in the output and in prune.md", () => {
    const p = ctx.set(itemsProject("prune-root-profile"));
    const t = fakeTrash(p.dir);
    const dir = archivedItem(p);
    fixture(dir);
    put(join(dir, "chrome-prof-root/Default/Login Data"), "secret");
    const dry = p.wip(["prune", "T1", "--dry-run"]);
    expect(dry.stdout).toContain("kept at the root: chrome-prof-root/ (browser profile)");
    expect(withTrash(p, t.ok, ["prune", "T1"]).code).toBe(0);
    expect(existsSync(join(dir, "chrome-prof-root/Default/Login Data"))).toBe(true);
    expect(readFileSync(join(dir, "prune.md"), "utf8")).toContain("- chrome-prof-root/");
  });

  test("a second real run stamps its date on prune.md and moves nothing", () => {
    const p = ctx.set(itemsProject("prune-rerun-date"));
    const t = fakeTrash(p.dir);
    const dir = archivedItem(p);
    fixture(dir);
    expect(withTrash(p, t.ok, ["prune", "T1"]).code).toBe(0);
    const first = readFileSync(join(dir, "prune.md"), "utf8");
    expect(withTrash(p, t.ok, ["prune", "T1"]).code).toBe(0);
    const second = readFileSync(join(dir, "prune.md"), "utf8");
    expect(second).toContain("(rerun, nothing new to prune; first run");
    expect(second).toContain("### Entries");
    expect(second).not.toBe(first);
    const db = p.db();
    expect(prunedEvents(db)).toBe(1);
    db.close();
  });

  test("--archived --flow prunes that flow only, skips open items, one folder in the trash, --report", () => {
    const p = ctx.set(itemsProject("prune-archived"));
    const t = fakeTrash(p.dir);
    const a = archivedItem(p, "T1");
    const b = archivedItem(p, "T2");
    itemInPlan(p, "T3");
    const open = join(p.dir, ".wip", "items", "valid", "T3");
    for (const d of [a, b, open]) fixture(d);
    const report = join(p.dir, "report.md");
    const out = jsonWithTrash(p, t.ok, [
      "prune",
      "--archived",
      "--flow",
      "valid",
      "--report",
      report,
    ]);
    const data = out.data as { items: { id: string }[]; totals: Record<string, number> };
    expect(data.items.map((i) => i.id)).toEqual(["T1", "T2"]);
    expect(Object.keys(data.totals).length).toBeGreaterThan(0);
    expect(files(a)).toEqual(KEPT);
    expect(files(b)).toEqual(KEPT);
    expect(files(open)).toContain("tmp/probe.ts");
    const trashed = readdirSync(t.trash);
    expect(trashed.length).toBe(1);
    expect(readdirSync(join(t.trash, trashed[0] as string, "valid")).sort()).toEqual(["T1", "T2"]);
    expect(out.events.length).toBe(2);
    expect(readFileSync(report, "utf8")).toContain("## Detail per item");
    const none = jsonWithTrash(p, t.ok, ["prune", "--archived", "--flow", "nope"]);
    expect((none.data as { items: unknown[] }).items).toEqual([]);
  });
});
