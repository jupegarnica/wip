// One tab per origin for `wip web`, on localhost and on the LAN: a BroadcastChannel election gives the origin to
// the last board tab opened and takes it back after a crash; padlocked tabs refuse. Ownership is per origin; a
// broadcast carries only ids, times and the padlock flag.
// biome-ignore lint/correctness/noUnusedVariables: the classic script app.js reads this global
const WipItemTabs = (() => {
  const CHANNEL_NAME = "wip-web.tabs"; // BroadcastChannel is already scoped to the origin
  const SETTLE_MS = 300; // election window after a claim
  const HANDOVER_MS = 1000; // how long an owner has to answer a claim before it is presumed gone
  const GRACE_MS = 60; // the owner waits this long after a claim for a later one (last one opened wins)
  const HEARTBEAT_MS = 2000; // owner beat
  const STALE_MS = 6000; // three missed beats: the owner is presumed crashed

  // A total order on (at, id), so two tabs that hear the same messages reach the same conclusion.
  function newer(a, b) {
    return a.at > b.at || (a.at === b.at && a.id < b.id);
  }

  function create(options = {}) {
    const Channel = "Channel" in options ? options.Channel : globalThis.BroadcastChannel || null;
    const onTakeOver = typeof options.onTakeOver === "function" ? options.onTakeOver : null;
    const settleMs = typeof options.settleMs === "number" ? options.settleMs : SETTLE_MS;
    const handoverMs = typeof options.handoverMs === "number" ? options.handoverMs : HANDOVER_MS;
    const graceMs = typeof options.graceMs === "number" ? options.graceMs : GRACE_MS;
    const heartbeatMs =
      typeof options.heartbeatMs === "number" ? options.heartbeatMs : HEARTBEAT_MS;
    const staleMs = typeof options.staleMs === "number" ? options.staleMs : STALE_MS;
    const now = typeof options.now === "function" ? options.now : Date.now;

    // Secure-context-only APIs (random UUIDs, Web Locks) are unavailable on the LAN; an id only has to be unique
    // among the tabs of one origin.
    const selfId = `${now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
    let state = "idle"; // "idle" | "contending" | "owner"
    let myAt = 0; // when this tab claimed the origin
    let locked = false; // the user closed the padlock: this tab keeps the origin
    let knownOwner = null; // {id, at, locked} of the owner last heard
    let lastHeardAt = null; // now() of the last owner/beat from knownOwner
    const claims = new Map(); // id -> at, the claims heard around a settlement
    let graceTo = null; // the claimant the owner will yield to at the end of the grace
    let claimSettle = null; // resolves claim() while contending
    let claimPromise = null;
    let pendingTakeOver = null; // {promise, resolve} while takeOver() waits for an answer
    let channel = null;
    const timers = { settle: null, handover: null, stale: null, grace: null, heartbeat: null };
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

    function clearTimer(name) {
      if (timers[name] === null) return;
      clearTimeout(timers[name]);
      timers[name] = null;
    }

    function setTimer(name, fn, ms) {
      clearTimer(name);
      timers[name] = setTimeout(() => {
        timers[name] = null;
        fn();
      }, ms);
    }

    function clearTimers() {
      for (const name of Object.keys(timers)) clearTimer(name);
    }

    function noteClaim(id, at) {
      const cutoff = now() - settleMs * 2;
      for (const [key, value] of claims) if (value < cutoff) claims.delete(key);
      claims.set(id, at);
    }

    // The claim recorded around this settlement with the greatest (at, id); ties go to the smaller id.
    function electWinner() {
      const cutoff = myAt - settleMs; // concurrent opens, not a claim from an older page
      let best = null;
      for (const [id, at] of claims) {
        if (at < cutoff) continue;
        const entry = { id, at };
        if (!best || newer(entry, best)) best = entry;
      }
      return best ? best.id : selfId;
    }

    function beat() {
      if (state !== "owner") return;
      post({ type: "beat", id: selfId, at: myAt, locked });
    }

    function stopHeartbeat() {
      clearTimer("heartbeat");
    }

    function scheduleBeat() {
      stopHeartbeat();
      timers.heartbeat = setTimeout(() => {
        timers.heartbeat = null;
        if (state !== "owner") return;
        beat();
        scheduleBeat();
      }, heartbeatMs);
    }

    function becomeOwner() {
      clearTimer("settle");
      clearTimer("handover");
      clearTimer("stale");
      state = "owner";
      post({ type: "owner", id: selfId, at: myAt, locked });
      beat();
      scheduleBeat();
    }

    function settleClaim(win) {
      if (!claimSettle) return;
      clearTimer("settle");
      const resolve = claimSettle;
      claimSettle = null;
      claimPromise = null;
      if (win) {
        becomeOwner();
        resolve(true);
        return;
      }
      if (state === "contending") state = "idle";
      resolve(false);
    }

    function resolveTakeOver(result) {
      if (!pendingTakeOver) return;
      clearTimer("handover");
      clearTimer("stale");
      const resolve = pendingTakeOver.resolve;
      pendingTakeOver = null;
      if (result !== "owner" && state === "contending") state = "idle";
      resolve(result);
    }

    // A yield to this tab (or a bye from the owner) makes it the owner right away.
    function winOrigin() {
      if (claimSettle) {
        settleClaim(true);
        return;
      }
      if (pendingTakeOver) {
        becomeOwner();
        resolveTakeOver("owner");
        return;
      }
      if (state === "owner") return;
      myAt = now();
      becomeOwner();
    }

    function staleTakeOver() {
      if (!pendingTakeOver) return;
      myAt = now();
      becomeOwner();
      resolveTakeOver("owner");
    }

    function onHandoverTimeout() {
      if (!pendingTakeOver) return;
      // A live owner answers at once; one that was heard but has gone quiet is replaced after STALE_MS.
      const delay =
        knownOwner && lastHeardAt !== null
          ? Math.max(0, staleMs - (now() - lastHeardAt))
          : settleMs;
      setTimer("stale", staleTakeOver, delay);
    }

    // Ownership is given up before the confirmation is posted, so a lost yield cannot leave two owners.
    function giveUpTo(to) {
      if (state !== "owner") return;
      if (locked) {
        post({ type: "deny", id: selfId, to }); // the padlock closed during the grace
        return;
      }
      state = "idle";
      stopHeartbeat();
      clearTimer("grace");
      post({ type: "yield", id: selfId, to, at: myAt });
      if (onTakeOver) onTakeOver();
    }

    // An older owner that hears a newer one demotes; a padlocked one demotes silently and survives.
    function demote() {
      state = "idle";
      stopHeartbeat();
      clearTimer("grace");
      if (!locked && onTakeOver) onTakeOver();
    }

    function onMessage(event) {
      const msg = event?.data;
      if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
      if (typeof msg.id !== "string" || msg.id === selfId) return;
      switch (msg.type) {
        case "claim":
          if (typeof msg.at !== "number") return;
          noteClaim(msg.id, msg.at);
          if (state !== "owner") return;
          if (locked) {
            post({ type: "deny", id: selfId, to: msg.id }); // never yield
            return;
          }
          post({ type: "owner", id: selfId, at: myAt, locked }); // it learns an owner exists
          graceTo = msg.id; // a burst yields once, to the last one
          setTimer("grace", () => giveUpTo(graceTo), graceMs);
          return;
        case "owner":
        case "beat":
          if (typeof msg.at !== "number") return;
          knownOwner = { id: msg.id, at: msg.at, locked: Boolean(msg.locked) };
          lastHeardAt = now();
          if (state === "owner") {
            if (newer(knownOwner, { id: selfId, at: myAt })) demote();
            return;
          }
          if (claimSettle) {
            settleClaim(false); // an owner exists
            return;
          }
          if (pendingTakeOver && timers.stale !== null) {
            // The owner still beats but does not answer: wait STALE_MS from its last beat.
            setTimer("stale", staleTakeOver, Math.max(0, staleMs - (now() - lastHeardAt)));
          }
          return;
        case "yield":
          if (typeof msg.to !== "string" || typeof msg.at !== "number") return;
          if (msg.to === selfId) winOrigin();
          else if (claimSettle) settleClaim(false);
          else if (pendingTakeOver) resolveTakeOver("unavailable");
          return;
        case "deny":
          if (typeof msg.to !== "string" || msg.to !== selfId) return;
          if (claimSettle) settleClaim(false);
          if (pendingTakeOver) resolveTakeOver("locked");
          return;
        case "bye":
          if (!knownOwner || knownOwner.id !== msg.id) return; // only the owner frees the origin
          knownOwner = null;
          lastHeardAt = null;
          if (claimSettle) settleClaim(electWinner() === selfId);
          else if (pendingTakeOver) winOrigin();
          return;
        default:
          return;
      }
    }

    if (channel) channel.onmessage = onMessage;

    function claim() {
      if (state === "owner") return Promise.resolve(true);
      if (!channel) {
        state = "owner"; // no BroadcastChannel: every tab is its own page
        myAt = now();
        return Promise.resolve(true);
      }
      if (claimPromise) return claimPromise;
      state = "contending";
      myAt = now();
      noteClaim(selfId, myAt);
      const promise = new Promise((resolve) => {
        claimSettle = resolve;
      });
      claimPromise = promise;
      setTimer("settle", () => settleClaim(electWinner() === selfId), settleMs);
      post({ type: "claim", id: selfId, at: myAt, locked });
      return promise;
    }

    function takeOver() {
      if (state === "owner") return Promise.resolve("owner");
      if (!channel) return Promise.resolve("unavailable");
      if (pendingTakeOver) return pendingTakeOver.promise;
      clearTimer("settle");
      if (claimSettle) settleClaim(false);
      state = "contending";
      myAt = now();
      let resolve = null;
      const promise = new Promise((done) => {
        resolve = done;
      });
      pendingTakeOver = { promise, resolve };
      setTimer("handover", onHandoverTimeout, handoverMs);
      if (!post({ type: "claim", id: selfId, at: myAt, locked })) resolveTakeOver("unavailable");
      return promise;
    }

    function release() {
      clearTimers();
      if (claimSettle) settleClaim(false);
      if (pendingTakeOver) resolveTakeOver("unavailable");
      if (state === "owner") post({ type: "bye", id: selfId });
      state = "idle";
      knownOwner = null;
      lastHeardAt = null;
      return Promise.resolve();
    }

    // Back/forward cache: the cached page lost the channel while it was frozen. Unless it is padlocked, a
    // restored page rejoins the election and closes if it does not get the origin.
    function resume() {
      clearTimers();
      if (claimSettle) settleClaim(false);
      if (pendingTakeOver) resolveTakeOver("unavailable");
      state = "idle";
      knownOwner = null;
      lastHeardAt = null;
      if (locked) return Promise.resolve();
      return takeOver().then((outcome) => {
        if (outcome !== "owner" && onTakeOver) onTakeOver();
      });
    }

    function stop() {
      clearTimers();
      if (claimSettle) settleClaim(false);
      if (pendingTakeOver) resolveTakeOver("unavailable");
      state = "idle";
      knownOwner = null;
      lastHeardAt = null;
      try {
        if (channel && typeof channel.close === "function") channel.close();
      } catch (_) {
        // a channel that is already gone is fine
      }
    }

    function setLocked(value) {
      const next = Boolean(value);
      if (next === locked) return;
      locked = next;
      if (locked && state === "owner") beat(); // announce the closed padlock
    }

    function isLocked() {
      return locked;
    }

    return { claim, release, setLocked, isLocked, takeOver, beat, resume, stop };
  }

  return { create };
})();
