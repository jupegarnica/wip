// Text imports: Bun inlines each file's text, including in `bun build --compile`. TypeScript types a `.js` import
// as the module and an `.html` one as a bundle, hence the expect-errors and the casts.
import appCss from "../../web/app.css" with { type: "text" };
// @ts-expect-error text import of a JavaScript file
import appJs from "../../web/app.js" with { type: "text" };
import iconSvg from "../../web/icon.svg" with { type: "text" };
import indexHtml from "../../web/index.html" with { type: "text" };
// @ts-expect-error text import of a JavaScript file
import markdownJs from "../../web/markdown.js" with { type: "text" };
// @ts-expect-error text import of a JavaScript file
import tabsJs from "../../web/tabs.js" with { type: "text" };
// @ts-expect-error text import of a JavaScript file
import vendorMarkdownJs from "../../web/vendor/markdown.js" with { type: "text" };
import viewHtml from "../../web/view.html" with { type: "text" };
// @ts-expect-error text import of a JavaScript file
import viewJs from "../../web/view.js" with { type: "text" };

const text = (value: unknown): string => value as string;

/** The page, keyed by its path under `web/`; served at `/<key>`. */
export const WEB: Readonly<Record<string, string>> = {
  "app.css": appCss,
  "app.js": text(appJs),
  "icon.svg": iconSvg,
  "index.html": text(indexHtml),
  "markdown.js": text(markdownJs),
  "tabs.js": text(tabsJs),
  "vendor/markdown.js": text(vendorMarkdownJs),
  "view.html": text(viewHtml),
  "view.js": text(viewJs),
};
