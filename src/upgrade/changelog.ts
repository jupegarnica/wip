/**
 * The release notes a successful `wip upgrade` shows: the sections of the target package's own `CHANGELOG.md`
 * between the version it replaced and the one it installed. Pure except for `readChangelog`, no dependency, and
 * nothing here throws: a missing file or an empty range is `null`, which the command turns into a warning.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersions, parseVersion } from "./version.ts";

export interface IChangelogEntry {
  /** The heading's first token, which must be a SemVer version. */
  version: string;
  /** The heading without its `## `, as written: `0.6.0 (2026-11-20)` or `0.6.0 (unreleased)`. */
  title: string;
  /** The lines under the heading, trimmed; empty when the section has none. */
  body: string;
}

export interface IReleaseNotes {
  /** The running version, exclusive. */
  from: string;
  /** The installed target, inclusive. */
  to: string;
  /** Newest first, in file order. */
  entries: IChangelogEntry[];
}

/**
 * The `## <version> …` sections of `markdown`, newest first. A heading whose first token is not a version
 * (`## Unreleased`, `## Next`) is skipped; a repeated version keeps its first section.
 */
export function parseChangelog(markdown: string): IChangelogEntry[] {
  const entries: IChangelogEntry[] = [];
  const seen = new Set<string>();
  let version: string | null = null;
  let title = "";
  let body: string[] = [];

  const flush = (): void => {
    if (version === null) return;
    if (!seen.has(version)) {
      seen.add(version);
      entries.push({ version, title, body: body.join("\n").trim() });
    }
    version = null;
    title = "";
    body = [];
  };

  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      flush();
      const heading = line.slice(3).trim();
      const first = heading.split(/\s+/)[0] ?? "";
      if (parseVersion(first) === null) continue;
      version = first;
      title = heading;
      continue;
    }
    if (version !== null) body.push(line);
  }
  flush();
  return entries;
}

/** The sections in `(from, to]`; `null` when there are none or a bound is not a version. */
export function releaseNotes(
  entries: readonly IChangelogEntry[],
  from: string,
  to: string,
): IReleaseNotes | null {
  if (parseVersion(from) === null || parseVersion(to) === null) return null;
  const kept = entries.filter(
    (entry) => compareVersions(entry.version, from) > 0 && compareVersions(entry.version, to) <= 0,
  );
  return kept.length === 0 ? null : { from, to, entries: kept };
}

/** `CHANGELOG.md` at the package root, or `null` when there is no root, no file or it cannot be read. */
export function readChangelog(root: string | null): string | null {
  if (root === null) return null;
  try {
    return readFileSync(join(root, "CHANGELOG.md"), "utf8");
  } catch {
    return null;
  }
}

export interface IFormattedNotes {
  lines: string[];
  truncated: boolean;
}

/** The text block, capped at `maxLines` including its first line; the full range stays in the JSON data. */
export function formatNotes(notes: IReleaseNotes, maxLines = 40): IFormattedNotes {
  const block = [`what's new (${notes.from} -> ${notes.to}):`];
  notes.entries.forEach((entry, index) => {
    if (index > 0) block.push("");
    block.push(entry.title);
    if (entry.body !== "") block.push(...entry.body.split("\n"));
  });
  if (block.length <= maxLines) return { lines: block, truncated: false };
  const hidden = block.length - maxLines;
  return {
    lines: [
      ...block.slice(0, maxLines),
      `… ${hidden} more line${hidden === 1 ? "" : "s"}; see CHANGELOG.md in the wip package`,
    ],
    truncated: true,
  };
}
