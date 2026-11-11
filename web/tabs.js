// One tab per origin for `wip web`: the owner hands the origin to a new tab and then tries to close itself,
// unless the user has closed the padlock. Web Locks decides ownership; BroadcastChannel asks and confirms.
// biome-ignore lint/correctness/noUnusedVariables: the classic script app.js reads this global
const WipItemTabs = (() => {
  const LOCK_NAME = "wip-web:tab"; // navigator.locks is already scoped to the origin
  const CHANNEL_NAME = "wip-web.tabs";
  const HANDOVER_MS = 1000; // wait for the owner's confirmation
  const CLAIM_TRIES = 3; // lock attempts after the confirmation
  const CLAIM_RETRY_MS = 100;

  function create(options = {}) {
    const locks = "locks" in options ? options.locks : globalThis.navigator?.locks || null;
    const Channel = "Channel" in options ? options.Channel : globalThis.BroadcastChannel || null;
    const onTakeOver = typeof options.onTakeOver === "function" ? options.onTakeOver : null;
    const handoverMs = typeof options.handoverMs === "number" ? options.handoverMs : HANDOVER_MS;
    let held = false;
    let yielding = false;
    let locked = false; // the user closed the padlock: this tab keeps the origin
    let releaseLock = null; // resolves the promise that keeps the lock
    let released = null; // resolves once the browser released the lock
    let pending = null; // a new tab waits for `yielded` or `locked`
    let channel = null;
    try {
      channel = Channel ? new Channel(CHANNEL_NAME) : null;
    } catch (_) {
      channel = null;
    }

    function post(message) {
      if (!channel) return false;
      try {
        channel.postMessage(message);
        return true;
      } catch (_) {
        return false;
      }
    }

    if (channel) {
      channel.onmessage = (event) => {
        const msg = event?.data;
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "yielded") {
          if (pending) pending.ack();
          return;
        }
        if (msg.type === "locked") {
          if (pending) pending.deny();
          return;
        }
        if (msg.type !== "takeover" || !held || yielding) return;
        if (locked) {
          post({ type: "locked" }); // still the owner: the new tab falls back at once
          return;
        }
        yielding = true; // one handover only, even with several requests
        release().then(() => {
          post({ type: "yielded" }); // the lock is already free
          if (onTakeOver) onTakeOver();
        });
      };
    }

    function claim() {
      if (held) return Promise.resolve(true);
      if (!locks) {
        held = true; // no Web Locks: as before, every tab is its own page
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        let settled = false;
        const mine = () => {
          if (!settled) {
            settled = true;
            held = true;
            resolve(true);
          }
        };
        const other = () => {
          if (!settled) {
            settled = true;
            resolve(false);
          }
        };
        try {
          const request = locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
            if (!lock) {
              other();
              return undefined;
            }
            mine();
            return new Promise((release) => {
              releaseLock = release;
            });
          });
          released = request.then(
            () => {
              held = false;
              releaseLock = null;
            },
            () => {
              held = false;
              releaseLock = null;
            },
          );
          request.catch(mine); // request() failed: behave like an origin without Web Locks
        } catch (_) {
          mine();
        }
      });
    }

    function release() {
      if (!held || !releaseLock) return Promise.resolve();
      held = false; // stop answering takeovers at once
      yielding = true;
      const done = released || Promise.resolve();
      releaseLock();
      releaseLock = null;
      return done; // resolves once the browser released the lock
    }

    // The padlock is per document and starts open on every load; only the owner consults it.
    function setLocked(value) {
      locked = Boolean(value);
    }

    function isLocked() {
      return locked;
    }

    function takeOver() {
      if (held) return Promise.resolve("owner");
      if (!locks || !channel) return Promise.resolve("unavailable");
      let settle = null;
      const answer = new Promise((resolve) => {
        settle = resolve;
      });
      pending = {
        ack: () => settle("yielded"),
        deny: () => settle("locked"),
      };
      if (!post({ type: "takeover" })) {
        pending = null;
        return Promise.resolve("unavailable");
      }
      let timer = null;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve("timeout"), handoverMs);
      });
      return Promise.race([answer, timeout]).then((outcome) => {
        clearTimeout(timer);
        pending = null;
        if (outcome === "locked") return "locked"; // the owner is locked: do not retry the lock
        let tries = 0;
        const attempt = () =>
          claim().then((ok) => {
            if (ok) return "owner";
            if (++tries >= CLAIM_TRIES) return "unavailable";
            return new Promise((resolve) => {
              setTimeout(resolve, CLAIM_RETRY_MS);
            }).then(attempt);
          });
        return attempt();
      });
    }

    return { claim, release, setLocked, isLocked, takeOver };
  }

  return { create };
})();
