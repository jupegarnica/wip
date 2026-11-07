import { parse } from "yaml";

/**
 * YAML as wip reads frontmatter and `wip-flow` blocks, on every runtime. The options match what Bun's YAML parser did before
 * (YAML 1.2 core schema, `<<` merge keys, a repeated key keeps the last value), so files that parsed keep their
 * meaning; warnings such as an unknown tag are not printed.
 */
export function parseYaml(text: string): unknown {
  return parse(text, { schema: "core", merge: true, uniqueKeys: false, logLevel: "error" });
}
