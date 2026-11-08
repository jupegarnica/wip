// Text imports: Bun inlines each file's text, including in `bun build --compile`, so the copy `wip init` writes
// travels inside the npm package and the standalone binary. TypeScript would type the `.tsx` as a module and the
// JSON as an object, hence the expect-errors and the casts; the mod's own tsconfig types it against the engine.
import plugin from "../../mods/wip-kanban/.claude-plugin/plugin.json" with { type: "text" };
import mark from "../../mods/wip-kanban/.claude-plugin/wip.json" with { type: "text" };
import hooks from "../../mods/wip-kanban/hooks/hooks.json" with { type: "text" };
// @ts-expect-error text import of a TSX module
import register from "../../mods/wip-kanban/hooks/register.tsx" with { type: "text" };
// @ts-expect-error text import of a file without an extension
import license from "../../mods/wip-kanban/LICENSE" with { type: "text" };
import readme from "../../mods/wip-kanban/README.md" with { type: "text" };
import tsconfig from "../../mods/wip-kanban/tsconfig.json" with { type: "text" };
// @ts-expect-error text import of a declaration file
import types from "../../mods/wip-kanban/types/index.d.ts" with { type: "text" };

const text = (value: unknown): string => value as string;

/** The files of the mod `wip init` copies, keyed by their path under `.claude/skills/wip-kanban/`. */
export const KANBAN_MOD: Readonly<Record<string, string>> = {
  ".claude-plugin/plugin.json": text(plugin),
  ".claude-plugin/wip.json": text(mark),
  "hooks/hooks.json": text(hooks),
  "hooks/register.tsx": text(register),
  "types/index.d.ts": text(types),
  "tsconfig.json": text(tsconfig),
  "README.md": text(readme),
  LICENSE: text(license),
};
