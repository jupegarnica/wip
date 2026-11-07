import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { extractBlocks } from "../../src/flow/parse.ts";
import { parseYaml } from "../../src/yaml.ts";

const ROOT = join(import.meta.dir, "..", "..");
const DIRS = ["templates", "test/fixtures"];
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function markdown(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdown(path);
    return path.endsWith(".md") ? [path] : [];
  });
}

/** Every frontmatter and `wip-flow` block wip ships or tests with. */
function documents(): [string, string][] {
  const docs: [string, string][] = [];
  for (const dir of DIRS) {
    for (const path of markdown(join(ROOT, dir))) {
      const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
      const name = relative(ROOT, path);
      const fm = text.match(FRONTMATTER_RE);
      if (fm) docs.push([`${name} frontmatter`, fm[1] ?? ""]);
      for (const block of extractBlocks(text)) docs.push([`${name} wip-flow`, block]);
    }
  }
  return docs;
}

type TOutcome = { value: unknown } | { error: true };

function outcome(parse: (text: string) => unknown, text: string): TOutcome {
  try {
    return { value: parse(text) };
  } catch {
    return { error: true };
  }
}

describe("parseYaml reads what Bun.YAML read", () => {
  const docs = documents();

  test("the shipped and fixture YAML is all there", () => {
    expect(docs.length).toBeGreaterThan(30);
  });

  test.each(docs)("%s", (_name, text) => {
    expect(outcome(parseYaml, text)).toEqual(outcome(Bun.YAML.parse, text));
  });

  test.each([
    ["a repeated key keeps the last value", "a: 1\na: 2"],
    ["merge keys", "base: &b {x: 1}\nother:\n  <<: *b\n  y: 2"],
    ["core schema booleans only", "a: yes\nb: on\nc: true"],
    ["numbers", "a: 0x1F\nb: 0o17\nc: 1e3\nd: .inf\ne: +1"],
    ["null and empty", "a: ~\nb:\n"],
    ["a date stays a string", "a: 2026-01-01"],
    ["an empty document", ""],
    ["only a comment", "# nothing"],
    ["a sequence at the top", "- a\n- b"],
    ["an unterminated quote", "x: 'open"],
    ["an unclosed flow sequence", "x: [1, 2"],
    ["bad indentation", "a:\n  b: 1\n c: 2"],
  ])("edge case: %s", (_name, text) => {
    expect(outcome(parseYaml, text)).toEqual(outcome(Bun.YAML.parse, text));
  });
});
