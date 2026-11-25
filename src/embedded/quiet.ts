// Text imports: Bun inlines each file's text, including in `bun build --compile`, so the copy `wip init` writes
// travels inside the npm package and the standalone binary. TypeScript would type the `.tsx`/`.ts` as modules and
// the JSON as an object, hence the expect-errors and the casts; the mod's own tsconfig types it against the engine.
import plugin from "../../mods/wip-quiet/.claude-plugin/plugin.json" with { type: "text" };
import mark from "../../mods/wip-quiet/.claude-plugin/wip.json" with { type: "text" };
// @ts-expect-error text import of a TS module
import classify from "../../mods/wip-quiet/hooks/classify.ts" with { type: "text" };
import hooks from "../../mods/wip-quiet/hooks/hooks.json" with { type: "text" };
// @ts-expect-error text import of a TSX module
import register from "../../mods/wip-quiet/hooks/register.tsx" with { type: "text" };
// @ts-expect-error text import of a TS module
import timestamps from "../../mods/wip-quiet/hooks/timestamps.ts" with { type: "text" };
// @ts-expect-error text import of a file without an extension
import license from "../../mods/wip-quiet/LICENSE" with { type: "text" };
import readme from "../../mods/wip-quiet/README.md" with { type: "text" };
import tsconfig from "../../mods/wip-quiet/tsconfig.json" with { type: "text" };
// @ts-expect-error text import of a declaration file
import types from "../../mods/wip-quiet/types/index.d.ts" with { type: "text" };

const text = (value: unknown): string => value as string;

/** The files of the mod `wip init` copies, keyed by their path under `.claude/skills/wip-quiet/`. */
export const QUIET_MOD: Readonly<Record<string, string>> = {
  ".claude-plugin/plugin.json": text(plugin),
  ".claude-plugin/wip.json": text(mark),
  LICENSE: text(license),
  "README.md": text(readme),
  "hooks/classify.ts": text(classify),
  "hooks/hooks.json": text(hooks),
  "hooks/register.tsx": text(register),
  "hooks/timestamps.ts": text(timestamps),
  "tsconfig.json": text(tsconfig),
  "types/index.d.ts": text(types),
};
