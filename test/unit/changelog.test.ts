import { describe, expect, test } from "bun:test";
import {
  formatNotes,
  type IReleaseNotes,
  parseChangelog,
  readChangelog,
  releaseNotes,
} from "../../src/upgrade/changelog.ts";

const CHANGELOG = `# Changelog

Each version lists its changes.

## 0.6.0-next.1 (2026-11-20)

- prerelease bullet

## 0.6.0 (unreleased)

- next bullet
  wrapped

## Unreleased

- this heading is not a version

## 0.5.1 (2026-11-13)

- old bullet

## 0.5.0 (2026-11-12)

- oldest bullet
`;

function notes(from: string, to: string, versions: string[]): IReleaseNotes | null {
  const entries = versions.map((version) => ({ version, title: version, body: `- ${version}` }));
  return releaseNotes(entries, from, to);
}

describe("parseChangelog", () => {
  test("sections keep their heading and body; a heading without a version is skipped", () => {
    const entries = parseChangelog(CHANGELOG);
    expect(entries.map((entry) => entry.version)).toEqual([
      "0.6.0-next.1",
      "0.6.0",
      "0.5.1",
      "0.5.0",
    ]);
    expect(entries[0]).toEqual({
      version: "0.6.0-next.1",
      title: "0.6.0-next.1 (2026-11-20)",
      body: "- prerelease bullet",
    });
    expect(entries[1]).toEqual({
      version: "0.6.0",
      title: "0.6.0 (unreleased)",
      body: "- next bullet\n  wrapped",
    });
  });

  test("a heading without a date parses; the preamble is not a section", () => {
    expect(parseChangelog("# Changelog\n\n## 1. Kimi\n\n- x\n\n## 1.2.3\n- a\n")).toEqual([
      { version: "1.2.3", title: "1.2.3", body: "- a" },
    ]);
  });

  test("junk headings and fenced-looking text never open a section", () => {
    const entries = parseChangelog("## Next\n- n\n## v1.2.3\n- v\n### 2.0.0\n## 1.0.0\n- a\n");
    expect(entries.map((entry) => entry.version)).toEqual(["1.0.0"]);
    expect(entries[0]?.body).toBe("- a");
  });

  test("CRLF is handled", () => {
    expect(parseChangelog("## 1.0.0\r\n- a\r\n\r\n## 0.9.0\r\n- b\r\n")).toEqual([
      { version: "1.0.0", title: "1.0.0", body: "- a" },
      { version: "0.9.0", title: "0.9.0", body: "- b" },
    ]);
  });

  test("a repeated version keeps its first section", () => {
    expect(parseChangelog("## 1.0.0\n- first\n## 1.0.0\n- second\n")).toEqual([
      { version: "1.0.0", title: "1.0.0", body: "- first" },
    ]);
  });

  test("an empty section has an empty body", () => {
    expect(parseChangelog("## 1.0.0\n\n## 0.9.0\n- b\n")[0]).toEqual({
      version: "1.0.0",
      title: "1.0.0",
      body: "",
    });
  });
});

describe("releaseNotes", () => {
  test("(from, to]: the running version is exclusive, the target inclusive, newest first", () => {
    const entries = ["0.3.0", "0.2.0", "0.1.0"];
    expect(notes("0.1.0", "0.3.0", entries)).toEqual({
      from: "0.1.0",
      to: "0.3.0",
      entries: [
        { version: "0.3.0", title: "0.3.0", body: "- 0.3.0" },
        { version: "0.2.0", title: "0.2.0", body: "- 0.2.0" },
      ],
    });
    expect(notes("0.2.0", "0.3.0", entries)?.entries.map((entry) => entry.version)).toEqual([
      "0.3.0",
    ]);
    expect(notes("0.0.1", "0.2.0", entries)?.entries.map((entry) => entry.version)).toEqual([
      "0.2.0",
      "0.1.0",
    ]);
  });

  test("prereleases compare as versions", () => {
    expect(
      notes("0.5.1", "0.6.0-next.1", ["0.6.0-next.1", "0.5.1"])?.entries.map((e) => e.version),
    ).toEqual(["0.6.0-next.1"]);
  });

  test("no section in range, or an invalid bound, is null", () => {
    const entries = ["0.3.0", "0.2.0"];
    expect(notes("1.0.0", "2.0.0", entries)).toBeNull();
    expect(notes("0.3.0", "0.3.0", entries)).toBeNull();
    expect(notes("nightly", "0.3.0", entries)).toBeNull();
    expect(notes("0.1.0", "1.0.0+build", entries)).toBeNull();
  });
});

describe("readChangelog", () => {
  test("no root or no file is null, never a throw", () => {
    expect(readChangelog(null)).toBeNull();
    expect(readChangelog("/nowhere/wip-package")).toBeNull();
  });
});

describe("formatNotes", () => {
  const sample: IReleaseNotes = {
    from: "0.5.1",
    to: "0.6.0",
    entries: [
      { version: "0.6.0", title: "0.6.0 (2026-11-20)", body: "- new" },
      { version: "0.5.2", title: "0.5.2 (2026-11-16)", body: "- fixed" },
    ],
  };

  test("the header, each heading and body, one blank line between entries", () => {
    expect(formatNotes(sample)).toEqual({
      lines: [
        "what's new (0.5.1 -> 0.6.0):",
        "0.6.0 (2026-11-20)",
        "- new",
        "",
        "0.5.2 (2026-11-16)",
        "- fixed",
      ],
      truncated: false,
    });
  });

  test("an empty body takes no line", () => {
    const empty: IReleaseNotes = {
      from: "0.5.1",
      to: "0.6.0",
      entries: [{ version: "0.6.0", title: "0.6.0", body: "" }],
    };
    expect(formatNotes(empty).lines).toEqual(["what's new (0.5.1 -> 0.6.0):", "0.6.0"]);
  });

  test("the block stops at 40 lines and names what is left", () => {
    const long: IReleaseNotes = {
      from: "0.5.1",
      to: "0.6.0",
      entries: [
        {
          version: "0.6.0",
          title: "0.6.0 (2026-11-20)",
          body: Array.from({ length: 60 }, (_, i) => `- line ${i + 1}`).join("\n"),
        },
      ],
    };
    const formatted = formatNotes(long);
    expect(formatted.truncated).toBe(true);
    expect(formatted.lines.length).toBe(41);
    expect(formatted.lines[0]).toBe("what's new (0.5.1 -> 0.6.0):");
    expect(formatted.lines[40]).toBe("… 22 more lines; see CHANGELOG.md in the wip package");
  });

  test("one hidden line is singular, and maxLines is overridable", () => {
    const long: IReleaseNotes = {
      from: "0.5.1",
      to: "0.6.0",
      entries: [
        {
          version: "0.6.0",
          title: "0.6.0",
          body: Array.from({ length: 39 }, (_, i) => `- line ${i + 1}`).join("\n"),
        },
      ],
    };
    expect(formatNotes(long).lines.at(-1)).toBe(
      "… 1 more line; see CHANGELOG.md in the wip package",
    );
    expect(formatNotes(sample, 2)).toEqual({
      lines: [
        "what's new (0.5.1 -> 0.6.0):",
        "0.6.0 (2026-11-20)",
        "… 4 more lines; see CHANGELOG.md in the wip package",
      ],
      truncated: true,
    });
  });
});
