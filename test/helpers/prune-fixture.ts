import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { IRunOutput } from "../../src/cli.ts";
import { type IJson, itemInPlan } from "./items.ts";
import type { IProject } from "./project.ts";

// Synthetic item folder and fake trash commands for the `wip prune` / `wip archive` tests. Never the real trash.

export function put(path: string, content: string | Buffer = "x"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Every regular file and link under `dir`, relative and sorted. */
export function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory() && !st.isSymbolicLink()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

/** Fake trash commands: `ok` moves its arguments to <home>/.Trash, `fail` exits 1. */
export function fakeTrash(home: string): { ok: string; fail: string; trash: string } {
  const trash = join(home, ".Trash");
  const ok = join(home, "fake-trash.sh");
  const fail = join(home, "fake-trash-fail.sh");
  writeFileSync(ok, `#!/bin/sh\nmkdir -p "${trash}" && mv "$@" "${trash}/"\n`);
  writeFileSync(fail, "#!/bin/sh\necho 'Operation not permitted' >&2\nexit 1\n");
  chmodSync(ok, 0o755);
  chmodSync(fail, 0o755);
  return { ok, fail, trash };
}

/** One file per rule (D1-D7) plus what has to stay (root entries, K1, R1, R2). */
export function fixture(dir: string): void {
  put(join(dir, "tmp/storybook-static/x.js"), "js");
  const macho = Buffer.alloc(1024 * 1024 + 10);
  Buffer.from("cffaedfe", "hex").copy(macho);
  put(join(dir, "tmp/fake-macho"), macho);
  put(join(dir, "tmp/lh/node_modules/a"), "a");
  put(join(dir, "tmp/p/chrome-prof/Default/Login Data"), "");
  put(join(dir, "sub/__pycache__/a.pyc"), "pyc");
  put(join(dir, "tmp/copy.sqlite"), "db");
  put(join(dir, "tmp/probe.ts"), "probe");
  put(join(dir, "tmp/qa1-evidence.png"), "png");
  put(join(dir, "tmp/notes.txt"), "notes");
  put(join(dir, "qa-report.md"), "Evidence: qa1-evidence.png\n");
  put(join(dir, "cierre.md"), "Notes in tmp/notes.txt\n");
  put(join(dir, "plan.md"), "# plan\n");
  put(join(dir, "old.log"), "log");
  put(join(dir, "_backup/a.tgz"), "tgz");
  put(join(dir, "_backup/plan.md"), "# old plan\n");
}

/** What a pruned fixture folder keeps (prune.md included). */
export const KEPT = [
  "_backup/a.tgz",
  "_backup/plan.md",
  "cierre.md",
  "old.log",
  "plan.md",
  "prune.md",
  "qa-report.md",
  "tmp/notes.txt",
  "tmp/qa1-evidence.png",
];

/** A project with the `valid` flow and one archived item T1 (archived with --no-prune); returns its folder. */
export function archivedItem(p: IProject, id = "T1", flow = "valid"): string {
  itemInPlan(p, id);
  const out = p.wip(["archive", id, "--no-prune"]);
  if (out.code !== 0) throw new Error(`archive ${id}: ${out.stderr}`);
  return join(p.dir, ".wip", "items", flow, id);
}

/** Runs `wip <argv>` with WIP_TRASH_CMD set. */
export function withTrash(p: IProject, cmd: string, argv: readonly string[]): IRunOutput {
  return p.wip(argv, { env: { WIP_TRASH_CMD: cmd } });
}

export function jsonWithTrash(p: IProject, cmd: string, argv: readonly string[]): IJson {
  return JSON.parse(withTrash(p, cmd, [...argv, "--json"]).stdout) as IJson;
}
