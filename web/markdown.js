// Shared by the item panel (app.js) and the /view page (view.js): fetches an artifact and, for .md, renders it to
// semantic HTML with the vendored `marked` (web/vendor/markdown.js, loaded on first use). A YAML front matter block at
// the top is shown as plain text above the render and never reaches marked. The HTML is parsed inert and adopted,
// never assigned as raw markup; raw HTML is allowed as the page CSP permits, and every link click is intercepted
// (http(s) in a new tab, file:// or an absolute path copied, any other scheme ignored).
// One IIFE and one global, WipMd: classic scripts share the global lexical scope, so a const repeated in app.js
// would stop it from loading.
// biome-ignore lint/correctness/noUnusedVariables: the global app.js and view.js read
const WipMd = (() => {
  const MD_MODULE = "/vendor/markdown.js";
  const MARKDOWN_MAX_BYTES = 512 * 1024; // above this the render would block the main thread: plain text
  const NOTICE_MS = 3000;
  const TIMEOUT_MS = 5000;

  let mdParse = null;
  let mdLoading = null;
  let notify = () => {};

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const itemPath = (flow, id) => `${encodeURIComponent(flow)}/${encodeURIComponent(id)}`;
  const artifactApiUrl = (flow, id, name) =>
    `/api/item/${itemPath(flow, id)}/artifact/${encodeURIComponent(name)}`;
  const artifactViewUrl = (flow, id, name) =>
    `/view/item/${itemPath(flow, id)}/artifact/${encodeURIComponent(name)}`;

  // Over the LAN the page is plain http (no secure context): navigator.clipboard fails and execCommand is the fallback.
  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (_) {
      const ta = el("textarea");
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (_) {
        ok = false;
      }
      ta.remove();
      return ok;
    }
  }

  const isMarkdown = (name) => /\.md$/i.test(name);

  // A YAML front matter block: a `---` line first, closed by another `---`. It is metadata, not Markdown, so it is cut
  // before marked and shown as it is; no YAML is parsed. An empty block is consumed and paints nothing.
  function splitFrontMatter(text) {
    const open = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(text);
    if (!open) return { frontmatter: "", body: text };
    const rest = text.slice(open[0].length);
    const close = /^---[ \t]*\r?$/m.exec(rest);
    if (!close) return { frontmatter: "", body: text };
    const frontmatter = rest.slice(0, close.index).replace(/\r?\n$/, "");
    const body = rest.slice(close.index + close[0].length).replace(/^\r?\n/, "");
    return { frontmatter: frontmatter.trim() ? frontmatter : "", body };
  }

  // The vendor is a classic script (an IIFE with one global): injected on first use, once, and cached.
  function loadMarkdown() {
    if (!mdLoading) {
      mdLoading = new Promise((resolve) => {
        const script = document.createElement("script");
        script.src = MD_MODULE;
        script.async = true;
        script.addEventListener("load", () => {
          mdParse = globalThis.WipMarkdown?.parseMarkdown ?? null;
          resolve(mdParse ? globalThis.WipMarkdown : null);
        });
        script.addEventListener("error", () => resolve(null));
        document.head.appendChild(script);
      });
    }
    return mdLoading;
  }

  // marked's HTML is parsed in an inert document and its nodes adopted: no markup assignment, no script on insert.
  // The front matter, when there is one, is a plain-text <pre> before the render. http(s) links open in another tab;
  // the delegated click handler copes with the rest.
  function mdNode(text, frontmatter) {
    if (!mdParse) return null;
    try {
      const html = mdParse(text);
      const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}`, "text/html");
      const box = el("article", "md");
      if (frontmatter) box.appendChild(el("pre", "frontmatter", frontmatter));
      for (const child of Array.from(doc.body.childNodes)) {
        box.appendChild(document.adoptNode(child));
      }
      for (const a of box.querySelectorAll("a")) {
        if (/^https?:\/\//i.test(a.getAttribute("href") || "")) {
          a.setAttribute("target", "_blank");
          a.setAttribute("rel", "noopener noreferrer");
        }
      }
      return box;
    } catch (_) {
      return null;
    }
  }

  async function loadPreview(flow, id, name) {
    let next;
    try {
      const res = await fetch(artifactApiUrl(flow, id, name), {
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      next = { name, text: res.ok ? await res.text() : `Cannot read it (HTTP ${res.status}).` };
      if (
        res.ok &&
        isMarkdown(name) &&
        next.text.length <= MARKDOWN_MAX_BYTES &&
        (await loadMarkdown())
      ) {
        const { frontmatter, body } = splitFrontMatter(next.text);
        next.md = mdNode(body, frontmatter);
      }
    } catch (_) {
      next = { name, text: "Cannot read it (offline)." };
    }
    return next;
  }

  // http(s) opens in another tab; file:// or an absolute path is copied; any other scheme (javascript:, mailto:…)
  // and anything else is cancelled. Links come from rendered HTML, also from its raw HTML.
  function onLinkClick(e) {
    const target = e.target;
    const a = target?.closest ? target.closest("a") : null;
    if (!a?.closest(".md")) return false;
    const href = a.getAttribute("href") || "";
    if (/^https?:\/\//i.test(href)) return false;
    e.preventDefault();
    if (/^file:\/\//i.test(href) || href.startsWith("/")) {
      let path = href.replace(/^file:\/\//i, "");
      try {
        path = decodeURIComponent(path);
      } catch (_) {
        // malformed escape: copy it as written
      }
      copyText(path).then((ok) => {
        notify(
          ok ? `path copied: ${path} (browsers do not open file://)` : `could not copy: ${path}`,
        );
      });
    }
    return true;
  }

  document.addEventListener("click", (e) => {
    onLinkClick(e);
  });

  function setNotice(fn) {
    notify = typeof fn === "function" ? fn : () => {};
  }

  return {
    NOTICE_MS,
    MARKDOWN_MAX_BYTES,
    artifactApiUrl,
    artifactViewUrl,
    copyText,
    loadPreview,
    onLinkClick,
    setNotice,
  };
})();
