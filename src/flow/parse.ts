export const PHASE_KINDS = ["work", "wait", "terminal"] as const;
export const GATES = ["ask", "auto", "none"] as const;
export const WAITING_DEFAULTS = ["agent", "user", "external", "none"] as const;
export const WRITES = ["artifacts", "project"] as const;
export const FIELD_TYPES = ["string", "int", "list", "ts", "enum"] as const;

export type TPhaseKind = (typeof PHASE_KINDS)[number];
export type TGate = (typeof GATES)[number];
export type TWaitingDefault = (typeof WAITING_DEFAULTS)[number];
export type TWrites = (typeof WRITES)[number];
export type TFieldType = (typeof FIELD_TYPES)[number];

export interface IPhase {
  name: string;
  kind: TPhaseKind;
  gate: TGate;
  next: string[];
  waitingDefault: TWaitingDefault;
  stage: string | null;
  agent: string | null;
  writes: TWrites;
}

export interface IFieldDef {
  type: TFieldType;
  values?: string[];
}

export interface ILink {
  /** Regular expression matched against the item ID or a field value; `url` uses its groups as `$1`… */
  pattern: string;
  url: string;
}

/** An item `wip init` creates once; it waits on the phase's `waiting_default`. */
export interface ISeedItem {
  id: string;
  phase: string;
  title: string | null;
  next: string | null;
  /** Files of the flow's skill folder that `wip init` copies into the item's artifact directory. */
  files: string[];
}

/** Plain JSON: the registry stores it as the last valid version of the flow. */
export interface IFlow {
  name: string;
  hash: string;
  version: 1;
  idPattern: string | null;
  fields: Record<string, IFieldDef>;
  links: ILink[];
  phases: IPhase[];
  seed: ISeedItem[];
  /** Text of `## Subagents`, `null` when the file has none. */
  subagents: string | null;
  /** Text of each `### <phase>` section, by phase name. */
  phaseNotes: Record<string, string>;
}

export interface IParsed {
  flow: IFlow | null;
  block: string | null;
  problems: string[];
}

export const FLOW_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const PHASE_NAME_RE = /^[a-z][a-z0-9_-]*$/;
const FIELD_NAME_RE = /^[a-z][a-z0-9_]*$/;
const ENUM_RE = /^enum\(([^)]*)\)$/;
const BLOCK_RE = /^```wip-flow[ \t]*\n([\s\S]*?)^```[ \t]*$/gm;

const TOP_KEYS = ["version", "id_pattern", "fields", "links", "phases", "seed"];
const SEED_KEYS = ["id", "phase", "title", "next", "files"];
export const DEFAULT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Item columns of the CLI; `title` is a column too but a flow may declare it as a field. */
export const RESERVED_FIELDS = [
  "id",
  "flow",
  "phase",
  "waiting_on",
  "next",
  "status",
  "artifact_dir",
  "fields",
  "created_at",
  "updated_at",
  "archived_at",
];

export function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function extractBlocks(text: string): string[] {
  return [...normalize(text).matchAll(BLOCK_RE)].map((m) => m[1] ?? "");
}

export function blockHash(block: string): string {
  return new Bun.CryptoHasher("sha256").update(block).digest("hex").slice(0, 16);
}

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  where: string,
  problems: string[],
): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value))
    return value as T;
  problems.push(`${where}: '${String(value)}' is not one of ${allowed.join(" | ")}`);
  return fallback;
}

function optionalText(value: unknown, where: string, problems: string[]): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  problems.push(`${where}: must be a non-empty string`);
  return null;
}

export function parseFieldType(spec: unknown, where: string, problems: string[]): IFieldDef {
  const s = typeof spec === "string" ? spec.trim() : "";
  const enumMatch = s.match(ENUM_RE);
  if (enumMatch) {
    const values = (enumMatch[1] ?? "")
      .split("|")
      .map((v) => v.trim())
      .filter(Boolean);
    if (values.length === 0) problems.push(`${where}: enum() needs at least one value`);
    if (new Set(values).size !== values.length) problems.push(`${where}: enum values repeat`);
    return { type: "enum", values };
  }
  if ((FIELD_TYPES as readonly string[]).includes(s) && s !== "enum") {
    return { type: s as TFieldType };
  }
  problems.push(`${where}: unknown type '${String(spec)}' (string | int | list | ts | enum(a|b))`);
  return { type: "string" };
}

function parsePhase(raw: unknown, index: number, problems: string[]): IPhase | null {
  if (!isMap(raw)) {
    problems.push(`phases[${index}]: must be a mapping`);
    return null;
  }
  if (typeof raw.name !== "string" || !PHASE_NAME_RE.test(raw.name)) {
    problems.push(
      `phases[${index}]: name '${String(raw.name)}' must match ${PHASE_NAME_RE.source}`,
    );
    return null;
  }
  const where = `phase ${raw.name}`;
  const kind = oneOf(raw.kind, PHASE_KINDS, "work", `${where}: kind`, problems);
  let next: string[] = [];
  if (raw.next !== undefined && raw.next !== null) {
    if (Array.isArray(raw.next) && raw.next.every((n) => typeof n === "string")) next = raw.next;
    else problems.push(`${where}: next must be a list of phase names`);
  }
  return {
    name: raw.name,
    kind,
    gate: oneOf(raw.gate, GATES, "none", `${where}: gate`, problems),
    next,
    waitingDefault: oneOf(
      raw.waiting_default,
      WAITING_DEFAULTS,
      kind === "terminal" ? "none" : "agent",
      `${where}: waiting_default`,
      problems,
    ),
    stage: optionalText(raw.stage, `${where}: stage`, problems),
    agent: optionalText(raw.agent, `${where}: agent`, problems),
    writes: oneOf(raw.writes, WRITES, "artifacts", `${where}: writes`, problems),
  };
}

function parseLinks(raw: unknown, problems: string[]): ILink[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    problems.push("links: must be a list of {pattern, url}");
    return [];
  }
  const links: ILink[] = [];
  raw.forEach((link, i) => {
    const where = `links[${i}]`;
    if (!isMap(link)) {
      problems.push(`${where}: must be a mapping with pattern and url`);
      return;
    }
    for (const key of Object.keys(link)) {
      if (key !== "pattern" && key !== "url") problems.push(`${where}: unknown key '${key}'`);
    }
    const pattern = optionalText(link.pattern, `${where}.pattern`, problems);
    const url = optionalText(link.url, `${where}.url`, problems);
    if (pattern === null || url === null) {
      if (link.pattern === undefined) problems.push(`${where}: missing pattern`);
      if (link.url === undefined) problems.push(`${where}: missing url`);
      return;
    }
    links.push({ pattern, url });
  });
  return links;
}

function parseSeed(raw: unknown, problems: string[]): ISeedItem[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    problems.push("seed: must be a list of {id, phase, title, next, files}");
    return [];
  }
  const seed: ISeedItem[] = [];
  raw.forEach((entry, i) => {
    const where = `seed[${i}]`;
    if (!isMap(entry)) {
      problems.push(`${where}: must be a mapping with id and phase`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!SEED_KEYS.includes(key)) problems.push(`${where}: unknown key '${key}'`);
    }
    if (entry.id === undefined) problems.push(`${where}: missing id`);
    if (entry.phase === undefined) problems.push(`${where}: missing phase`);
    const id = optionalText(entry.id, `${where}.id`, problems);
    const phase = optionalText(entry.phase, `${where}.phase`, problems);
    const title = optionalText(entry.title, `${where}.title`, problems);
    const next = optionalText(entry.next, `${where}.next`, problems);
    let files: string[] = [];
    if (entry.files !== undefined && entry.files !== null) {
      if (Array.isArray(entry.files) && entry.files.every((f) => typeof f === "string")) {
        files = entry.files;
      } else problems.push(`${where}.files: must be a list of file names`);
    }
    if (id !== null && phase !== null) seed.push({ id, phase, title, next, files });
  });
  return seed;
}

function parseFields(raw: unknown, problems: string[]): Record<string, IFieldDef> {
  const fields: Record<string, IFieldDef> = {};
  if (raw === undefined || raw === null) return fields;
  if (!isMap(raw)) {
    problems.push("fields: must be a mapping of name: type");
    return fields;
  }
  for (const [key, spec] of Object.entries(raw)) {
    const where = `fields.${key}`;
    if (!FIELD_NAME_RE.test(key))
      problems.push(`${where}: name must match ${FIELD_NAME_RE.source}`);
    else if (RESERVED_FIELDS.includes(key)) problems.push(`${where}: '${key}' is an item column`);
    fields[key] = parseFieldType(spec, where, problems);
  }
  return fields;
}

const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

interface IHeading {
  level: number;
  title: string;
  line: number;
}

function headings(lines: readonly string[]): IHeading[] {
  const found: IHeading[] = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) return;
    const m = line.match(HEADING_RE);
    if (m) found.push({ level: (m[1] ?? "").length, title: (m[2] ?? "").trim(), line: i });
  });
  return found;
}

function sectionText(
  lines: readonly string[],
  all: IHeading[],
  at: number,
  stopsAt: (h: IHeading) => boolean = () => false,
): string {
  const head = all[at] as IHeading;
  const end = all.slice(at + 1).find((h) => h.level <= head.level || stopsAt(h));
  return lines
    .slice(head.line + 1, end ? end.line : lines.length)
    .join("\n")
    .trim();
}

/** `## Subagents` and the `### <phase>` sections, as plain text the coordinator hands on. */
export function extractSections(
  text: string,
  phaseNames: readonly string[],
): { subagents: string | null; phaseNotes: Record<string, string> } {
  const lines = normalize(text).split("\n");
  const all = headings(lines);
  let subagents: string | null = null;
  const phaseNotes: Record<string, string> = {};
  const titleOf = (h: IHeading): string => h.title.replace(/`/g, "").trim();
  const isPhase = (h: IHeading): boolean => h.level === 3 && phaseNames.includes(titleOf(h));
  all.forEach((h, i) => {
    const title = titleOf(h);
    // The `### <phase>` sections may sit under `## Subagents`; they are not part of its own text.
    if (h.level === 2 && title === "Subagents") subagents = sectionText(lines, all, i, isPhase);
    if (isPhase(h) && !(title in phaseNotes)) {
      phaseNotes[title] = sectionText(lines, all, i);
    }
  });
  return { subagents, phaseNotes };
}

/** Shape of the file and its `wip-flow` block; the graph, agent and item rules are in lint.ts. */
export function parseFlow(name: string, text: string): IParsed {
  const problems: string[] = [];
  if (!FLOW_NAME_RE.test(name)) {
    problems.push(`flow name '${name}' must match ${FLOW_NAME_RE.source} (it names the file)`);
  }
  const blocks = extractBlocks(text);
  if (blocks.length === 0)
    return { flow: null, block: null, problems: [...problems, "no ```wip-flow block"] };
  if (blocks.length > 1) {
    return {
      flow: null,
      block: null,
      problems: [...problems, `${blocks.length} wip-flow blocks: a flow has exactly one`],
    };
  }
  const block = blocks[0] as string;
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(block);
  } catch (err) {
    return {
      flow: null,
      block,
      problems: [...problems, `the wip-flow block is not valid YAML: ${(err as Error).message}`],
    };
  }
  if (!isMap(raw)) {
    return { flow: null, block, problems: [...problems, "the wip-flow block must be a mapping"] };
  }
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.includes(key)) problems.push(`unknown key '${key}' (${TOP_KEYS.join(", ")})`);
  }
  if (raw.version !== undefined && raw.version !== 1) {
    problems.push(`version ${String(raw.version)}: only 1 is supported`);
  }
  const idPattern = optionalText(raw.id_pattern, "id_pattern", problems);
  const phases: IPhase[] = [];
  if (!Array.isArray(raw.phases) || raw.phases.length === 0) {
    problems.push("phases: must be a non-empty list");
  } else {
    raw.phases.forEach((p, i) => {
      const phase = parsePhase(p, i, problems);
      if (phase) phases.push(phase);
    });
  }
  const sections = extractSections(
    text,
    phases.map((p) => p.name),
  );
  return {
    block,
    problems,
    flow: {
      name,
      hash: blockHash(block),
      version: 1,
      idPattern,
      fields: parseFields(raw.fields, problems),
      links: parseLinks(raw.links, problems),
      phases,
      seed: parseSeed(raw.seed, problems),
      ...sections,
    },
  };
}
