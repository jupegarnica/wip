// Text imports: Bun inlines each file's text, including in `bun build --compile`. TypeScript types a `.js` import
// as the module and an `.html` one as a bundle, hence the expect-errors and the casts.
// @ts-expect-error text import of a JavaScript file
import mdGeometry from "../../node_modules/@garndev/markdown/dist/geometry.js" with {
  type: "text",
};
// @ts-expect-error text import of a JavaScript file
import mdHighlight from "../../node_modules/@garndev/markdown/dist/highlight.js" with {
  type: "text",
};
// @ts-expect-error text import of a JavaScript file
import mdIndex from "../../node_modules/@garndev/markdown/dist/index.js" with { type: "text" };
// @ts-expect-error text import of a JavaScript file
import mdLinkHover from "../../node_modules/@garndev/markdown/dist/link-hover.js" with {
  type: "text",
};
// @ts-expect-error text import of a JavaScript file
import mdMeasure from "../../node_modules/@garndev/markdown/dist/measure.js" with { type: "text" };
// @ts-expect-error text import of a JavaScript file
import mdRender from "../../node_modules/@garndev/markdown/dist/render.js" with { type: "text" };
// @ts-expect-error text import of a JavaScript file
import mdWrap from "../../node_modules/@garndev/markdown/dist/wrap.js" with { type: "text" };
import mdTokens from "../../node_modules/@garndev/markdown/tokens.css" with { type: "text" };
import appCss from "../../web/app.css" with { type: "text" };
// @ts-expect-error text import of a JavaScript file
import appJs from "../../web/app.js" with { type: "text" };
import iconSvg from "../../web/icon.svg" with { type: "text" };
import indexHtml from "../../web/index.html" with { type: "text" };
// @ts-expect-error text import of a JavaScript file
import markdownJs from "../../web/markdown.js" with { type: "text" };
// @ts-expect-error text import of a JavaScript file
import tabsJs from "../../web/tabs.js" with { type: "text" };
import viewHtml from "../../web/view.html" with { type: "text" };
// @ts-expect-error text import of a JavaScript file
import viewJs from "../../web/view.js" with { type: "text" };

const text = (value: unknown): string => value as string;

/** The page, keyed by its path under `web/`. */
export const WEB: Readonly<Record<string, string>> = {
  "app.css": appCss,
  "app.js": text(appJs),
  "icon.svg": iconSvg,
  "index.html": text(indexHtml),
  "markdown.js": text(markdownJs),
  "tabs.js": text(tabsJs),
  "view.html": text(viewHtml),
  "view.js": text(viewJs),
};

export const MARKDOWN_PACKAGE = "@garndev/markdown";

/**
 * `@garndev/markdown@0.3.1`, keyed by its path in the package. Its `exports` only expose `.`, so the files are
 * imported by path; every module `dist/index.js` reaches must be here or the page's `import()` fails.
 */
export const MARKDOWN_LIB: Readonly<Record<string, string>> = {
  "dist/geometry.js": text(mdGeometry),
  "dist/highlight.js": text(mdHighlight),
  "dist/index.js": text(mdIndex),
  "dist/link-hover.js": text(mdLinkHover),
  "dist/measure.js": text(mdMeasure),
  "dist/render.js": text(mdRender),
  "dist/wrap.js": text(mdWrap),
  "tokens.css": mdTokens,
};
