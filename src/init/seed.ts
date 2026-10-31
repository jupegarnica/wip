import { copyFileSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { artifactFile } from "../artifact-name.ts";
import { iso } from "../clock.ts";
import { openDb, openForRead, type TDatabase } from "../db.ts";
import { artifactDir, FLOW_SKILL_PREFIX, type IRoot } from "../env.ts";
import type { IFlow, ISeedItem } from "../flow/parse.ts";
import { loadFlows } from "../flow/registry.ts";
import { assertItem } from "../invariants.ts";
import { addEvent, findItem, phaseOf } from "../items.ts";

export interface ISeeded {
  id: string;
  flow: string;
  phase: string;
  /** `exists`: an item with that ID is already there, open or archived; init never touches it. */
  action: "seeded" | "exists";
  /** Files copied into its artifact directory by this run; empty for `exists`. */
  files: string[];
}

interface ISeedOf {
  flow: IFlow;
  seed: ISeedItem;
}

/** Seeds of the flows that pass lint, by flow name; a flow file that fails lint seeds nothing. */
function declaredSeeds(root: IRoot, db: TDatabase | null, write = false): ISeedOf[] {
  const set = loadFlows(root, db, { write });
  return [...set.entries.values()]
    .filter((e) => e.source === "file" && e.flow !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.flow as IFlow).seed.map((seed) => ({ flow: e.flow as IFlow, seed })));
}

function insert(db: TDatabase, root: IRoot, { flow, seed }: ISeedOf): void {
  const phase = phaseOf(flow, seed.phase);
  const waiting = phase?.waitingDefault ?? "user";
  const next = seed.next ?? (waiting === "user" ? `continue ${seed.phase}` : null);
  const dir = artifactDir(root, flow.name, seed.id);
  const ts = iso();
  db.query(
    `INSERT INTO items (id, flow, title, phase, waiting_on, next, artifact_dir, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(seed.id, flow.name, seed.title, seed.phase, waiting, next, dir, ts, ts);
  addEvent(db, {
    itemId: seed.id,
    phase: seed.phase,
    kind: "phase",
    actor: "init",
    text: `created in ${seed.phase} by wip init`,
    data: { from: null, to: seed.phase, waiting_on: waiting, next },
  });
  assertItem(db, seed.id, flow);
  copySeedFiles(root, flow.name, seed, dir);
}

// Inside the transaction: a copy that fails rolls the item back, so no seeded item lacks its files.
function copySeedFiles(root: IRoot, flow: string, seed: ISeedItem, dir: string): void {
  mkdirSync(dir, { recursive: true });
  if (seed.files.length === 0) return;
  const skillDir = realpathSync(join(root.skills, `${FLOW_SKILL_PREFIX}${flow}`));
  for (const name of seed.files) {
    const source = artifactFile(skillDir, name);
    if (source === null) throw new Error(`seed ${seed.id}: ${name} is not in ${skillDir}`);
    copyFileSync(source, join(dir, name));
  }
}

function allExist(root: IRoot): ISeeded[] | null {
  const db = openForRead(root.db);
  try {
    const seeds = declaredSeeds(root, db);
    if (seeds.some(({ seed }) => findItem(db, seed.id) === null)) return null;
    return seeds.map(({ flow, seed }) => ({
      id: seed.id,
      flow: flow.name,
      phase: seed.phase,
      action: "exists",
      files: [],
    }));
  } finally {
    db?.close();
  }
}

/**
 * Creates each item the flows declare in `seed` once: an ID already in the database, open or archived, is left
 * alone, so `--force` and a second init never duplicate nor revive it. With nothing to create, the database is
 * not opened for writing.
 */
export function seedItems(root: IRoot): ISeeded[] {
  const unchanged = allExist(root);
  if (unchanged !== null) return unchanged;
  const db = openDb(root.db);
  try {
    return db
      .transaction(() =>
        declaredSeeds(root, db, true).map((s): ISeeded => {
          const action = findItem(db, s.seed.id) ? "exists" : "seeded";
          if (action === "seeded") insert(db, root, s);
          const files = action === "seeded" ? s.seed.files : [];
          return { id: s.seed.id, flow: s.flow.name, phase: s.seed.phase, action, files };
        }),
      )
      .immediate();
  } finally {
    db.close();
  }
}
