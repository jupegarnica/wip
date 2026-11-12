// /view/item/<flow>/<ID>/artifact/<name>: one artifact on its own page. Flow, ID and name come from the URL and are
// painted with textContent only. No polling: reload to see changes.
(() => {
  const body = document.getElementById("view-body");
  const noticeEl = document.getElementById("view-notice");

  function parts() {
    const m = /^\/view\/item\/([^/]+)\/([^/]+)\/artifact\/([^/]+)$/.exec(location.pathname);
    if (!m) return null;
    try {
      return {
        flow: decodeURIComponent(m[1]),
        id: decodeURIComponent(m[2]),
        name: decodeURIComponent(m[3]),
      };
    } catch (_) {
      return null;
    }
  }

  function message(text) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = text;
    body.replaceChildren(p);
  }

  let noticeTimer = null;
  function notify(text) {
    clearTimeout(noticeTimer);
    noticeEl.textContent = text;
    noticeTimer = setTimeout(() => {
      noticeEl.textContent = "";
    }, WipMd.NOTICE_MS);
  }

  async function main() {
    const p = parts();
    if (!p) {
      message("Invalid path.");
      return;
    }
    WipMd.setNotice(notify);
    document.title = `${p.name} · ${p.id}`;
    const preview = await WipMd.loadPreview(p.flow, p.id, p.name);
    if (preview.md) {
      body.replaceChildren(preview.md);
    } else {
      const pre = document.createElement("pre");
      pre.textContent = preview.text;
      body.replaceChildren(pre);
    }
  }

  main();
})();
