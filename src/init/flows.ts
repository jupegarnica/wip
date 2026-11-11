import { flowNames } from "../embedded/templates.ts";
import { usage } from "../errors.ts";

/**
 * `--flows`: a comma-separated list of shipped flows, trimmed, duplicates removed, at least one. Unknown or empty
 * names are a usage error, so nothing is written.
 */
export function parseFlows(text: string): string[] {
  const shipped = flowNames();
  const picked: string[] = [];
  if (text.trim() === "") {
    throw usage(`--flows: at least one flow; use ${shipped.join(", ")}`);
  }
  for (const raw of text.split(",")) {
    const name = raw.trim();
    if (name === "") {
      throw usage(`--flows: missing a flow name; use ${shipped.join(", ")}`);
    }
    if (!shipped.includes(name)) {
      throw usage(`--flows: unknown flow "${name}"; use ${shipped.join(", ")}`);
    }
    if (!picked.includes(name)) picked.push(name);
  }
  return picked;
}
