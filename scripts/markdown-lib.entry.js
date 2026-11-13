// Entry of the vendored Markdown renderer: `marked` only, exposed as a global for the page's classic scripts.
// `bun run vendor:markdown` bundles it (minified, iife) into web/vendor/markdown.js; nothing else imports this file.
import { marked } from "marked";

globalThis.WipMarkdown = {
  parseMarkdown: (text) => marked.parse(text, { gfm: true, breaks: true }),
};
