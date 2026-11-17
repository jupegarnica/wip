import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const REPO = join(import.meta.dir, "..", "..");
const SOURCE = readFileSync(join(REPO, "web", "tabs.js"), "utf8");
const CHANNEL_NAME = "wip-web.tabs";

type TOutcome = "owner" | "locked" | "unavailable";
type TTabs = {
  claim: () => Promise<boolean>;
  release: () => Promise<void>;
  setLocked: (value: boolean) => void;
  isLocked: () => boolean;
  takeOver: () => Promise<TOutcome>;
  beat: () => void;
  resume: () => Promise<void>;
  stop: () => void;
};
type TCreate = (options?: Record<string, unknown>) => TTabs;
type TMessage = { data: unknown };
type TListener = (event: TMessage) => void;

/** Runs the classic script in a fresh context, with the global captured for the test. */
function load(): { create: TCreate } {
  const context: Record<string, unknown> = { setTimeout, clearTimeout };
  runInNewContext(`${SOURCE}\nglobalThis.WipItemTabs = WipItemTabs;\n`, context, {
    filename: "tabs.js",
  });
  const api = context.WipItemTabs as { create: TCreate } | undefined;
  if (!api) throw new Error("web/tabs.js did not define WipItemTabs");
  return api;
}

/** Fast, injected timings: every test runs in milliseconds and ends without a pending heartbeat. */
const FAST = { settleMs: 5, handoverMs: 5, graceMs: 5, heartbeatMs: 10, staleMs: 25 };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeBus {
  readonly channels: FakeChannel[] = [];
}

class FakeChannel {
  onmessage: TListener | null = null;

  constructor(
    private readonly bus: FakeBus,
    readonly name: string,
  ) {
    bus.channels.push(this);
  }

  postMessage(data: unknown): void {
    for (const other of this.bus.channels) {
      if (other !== this && other.name === this.name) other.onmessage?.({ data });
    }
  }
}

/** A BroadcastChannel constructor bound to one bus, so two "tabs" share it. */
function channelOn(
  bus: FakeBus,
  Base: typeof FakeChannel = FakeChannel,
): new (
  name: string,
) => FakeChannel {
  return class Channel extends Base {
    constructor(name: string) {
      super(bus, name);
    }
  };
}

/** A bare channel on the bus, to send foreign messages and to spy on what the tabs post. */
function raw(bus: FakeBus): FakeChannel {
  const Channel = channelOn(bus);
  return new Channel(CHANNEL_NAME);
}

const made: TTabs[] = [];
function make(create: TCreate, bus: FakeBus, options: Record<string, unknown> = {}): TTabs {
  const Channel = channelOn(bus);
  const instance = create({ Channel, ...FAST, ...options });
  made.push(instance);
  return instance;
}

afterEach(() => {
  for (const instance of made.splice(0)) instance.stop();
});

describe("wip web tabs (F-WEB-10)", () => {
  test("the first board tab owns the origin and a later one takes it over", async () => {
    const { create } = load();
    const bus = new FakeBus();
    let handed = 0;
    const a = make(create, bus, { onTakeOver: () => (handed += 1) });
    const b = make(create, bus);
    expect(await a.claim()).toBe(true);
    expect(await b.claim()).toBe(false);
    expect(await b.takeOver()).toBe("owner");
    expect(handed).toBe(1);
    expect(await b.claim()).toBe(true);
    // b answers as the owner, so a is no longer the owner of the origin.
    expect(await a.claim()).toBe(false);
    expect(handed).toBe(1);
  });

  test("two simultaneous opens elect exactly one owner", async () => {
    const { create } = load();
    const bus = new FakeBus();
    let handed = 0;
    const a = make(create, bus, { onTakeOver: () => (handed += 1) });
    const b = make(create, bus, { onTakeOver: () => (handed += 1) });
    const owners = await Promise.all([a.claim(), b.claim()]);
    expect(owners.filter(Boolean)).toHaveLength(1);
    const winner = owners[0] ? a : b;
    const loser = owners[0] ? b : a;
    // The loser asks the winner, which always yields, so the final owner is the tab opened last.
    expect(await loser.takeOver()).toBe("owner");
    expect(await winner.claim()).toBe(false);
    expect(await loser.claim()).toBe(true);
    expect(handed).toBe(1);
  });

  test("the last claim in a burst wins", async () => {
    const { create } = load();
    const bus = new FakeBus();
    let handed = 0;
    const owner = make(create, bus, { onTakeOver: () => (handed += 1) });
    expect(await owner.claim()).toBe(true);
    const spy = raw(bus);
    const seen: { type?: string; to?: string }[] = [];
    spy.onmessage = (event) => seen.push(event.data as { type?: string; to?: string });
    spy.postMessage({ type: "claim", id: "first", at: 10, locked: false });
    spy.postMessage({ type: "claim", id: "second", at: 11, locked: false });
    await wait(20);
    expect(handed).toBe(1);
    const yields = seen.filter((message) => message.type === "yield");
    expect(yields).toHaveLength(1);
    expect(yields[0]?.to).toBe("second");
  });

  test("an owner that stops beating is replaced after the stale timeout", async () => {
    const { create } = load();
    const bus = new FakeBus();
    const newcomer = make(create, bus);
    const peer = raw(bus);
    peer.postMessage({ type: "beat", id: "silent", at: Date.now(), locked: false });
    const started = Date.now();
    expect(await newcomer.takeOver()).toBe("owner");
    const elapsed = Date.now() - started;
    // Not immediate and not after the handover alone: it waits STALE_MS from the last beat.
    expect(elapsed).toBeGreaterThanOrEqual(FAST.staleMs - 10);
    expect(elapsed).toBeLessThan(500);
  });

  test("release on pagehide frees the origin at once", async () => {
    const { create } = load();
    const bus = new FakeBus();
    const owner = make(create, bus);
    const newcomer = make(create, bus, { staleMs: 500 });
    expect(await owner.claim()).toBe(true);
    await owner.release();
    const started = Date.now();
    expect(await newcomer.claim()).toBe(true);
    expect(Date.now() - started).toBeLessThan(200);

    const third = make(create, bus);
    await third.release(); // a release from a tab that is not the owner changes nothing
    expect(await third.claim()).toBe(false);
  });

  test("the padlock refuses the takeover and the owner keeps the origin", async () => {
    const { create } = load();
    const bus = new FakeBus();
    let handed = 0;
    const owner = make(create, bus, { onTakeOver: () => (handed += 1) });
    const newcomer = make(create, bus);
    expect(await owner.claim()).toBe(true);
    owner.setLocked(true);
    expect(await newcomer.claim()).toBe(false);
    expect(await newcomer.takeOver()).toBe("locked"); // at once: a wait would answer "unavailable"
    expect(handed).toBe(0);
    expect(await owner.claim()).toBe(true);
    expect(await newcomer.claim()).toBe(false);
  });

  test("opening the padlock allows the handover", async () => {
    const { create } = load();
    const bus = new FakeBus();
    let handed = 0;
    const owner = make(create, bus, { onTakeOver: () => (handed += 1) });
    const newcomer = make(create, bus);
    expect(await owner.claim()).toBe(true);
    owner.setLocked(true);
    expect(await newcomer.takeOver()).toBe("locked");
    owner.setLocked(false);
    expect(await newcomer.takeOver()).toBe("owner");
    expect(handed).toBe(1);
    expect(await newcomer.claim()).toBe(true);
    expect(await owner.claim()).toBe(false);
  });

  test("a padlocked owner bypassed while silent keeps its padlock and does not close", async () => {
    const { create } = load();
    const ownerBus = new FakeBus();
    const newcomerBus = new FakeBus();
    let handed = 0;
    const owner = make(create, ownerBus, { onTakeOver: () => (handed += 1) });
    expect(await owner.claim()).toBe(true);
    owner.setLocked(true);
    // The newcomer never hears the owner: its beats and answers are not delivered to this bus.
    const newcomer = make(create, newcomerBus, { staleMs: 10 });
    expect(await newcomer.takeOver()).toBe("owner");
    const peer = raw(ownerBus);
    peer.postMessage({ type: "beat", id: "newer", at: Date.now() + 1000, locked: false });
    expect(handed).toBe(0); // demoted silently: a padlocked tab is never closed automatically
    expect(owner.isLocked()).toBe(true);
    expect(await newcomer.claim()).toBe(true);
  });

  test("without BroadcastChannel every tab owns the origin and cannot ask", async () => {
    const { create } = load();
    const a = make(create, new FakeBus(), { Channel: null });
    const b = make(create, new FakeBus(), { Channel: null });
    expect(await a.claim()).toBe(true);
    expect(await b.claim()).toBe(true);
    expect(await create({ Channel: null }).takeOver()).toBe("unavailable");
  });

  test("a claim takes no item key", () => {
    const { create } = load();
    const a = make(create, new FakeBus());
    expect(a.claim.length).toBe(0);
    expect(a.takeOver.length).toBe(0);
  });

  test("foreign and malformed messages are ignored without throwing", async () => {
    const { create } = load();
    const bus = new FakeBus();
    let handed = 0;
    const owner = make(create, bus, { onTakeOver: () => (handed += 1) });
    expect(await owner.claim()).toBe(true);
    const sender = raw(bus);
    for (const data of [
      null,
      undefined,
      "text",
      42,
      [],
      { type: "nope" },
      { type: "takeover" },
      { type: "yielded" },
      { type: "locked" },
      { type: "claim" },
      { type: "claim", id: "x" },
      { type: "yield", id: "x", to: "owner" },
      { type: "bye" },
    ]) {
      sender.postMessage(data);
    }
    await wait(20);
    expect(handed).toBe(0);
    expect(await owner.claim()).toBe(true);
  });

  test("a channel that throws does not break the claim nor the handover", async () => {
    const { create } = load();
    class BrokenChannel {
      onmessage: TListener | null = null;
      postMessage(): void {
        throw new Error("closed");
      }
    }
    const owner = create({ Channel: BrokenChannel, ...FAST });
    const secondary = create({ Channel: BrokenChannel, ...FAST });
    made.push(owner, secondary);
    expect(await owner.claim()).toBe(true); // nothing is delivered: each tab is its own page
    expect(await secondary.claim()).toBe(true);
    const failed = create({ Channel: BrokenChannel, ...FAST });
    made.push(failed);
    expect(await failed.takeOver()).toBe("unavailable"); // a claim that cannot be posted cannot ask

    const bus = new FakeBus();
    class YieldThrowingChannel extends FakeChannel {
      override postMessage(data: unknown): void {
        if ((data as { type?: string })?.type === "yield") throw new Error("closed");
        super.postMessage(data);
      }
    }
    const Channel = channelOn(bus, YieldThrowingChannel);
    let handed = 0;
    const owner2 = create({ Channel, ...FAST, onTakeOver: () => (handed += 1) });
    const newcomer = create({ Channel, ...FAST });
    made.push(owner2, newcomer);
    expect(await owner2.claim()).toBe(true);
    expect(await newcomer.claim()).toBe(false);
    expect(await newcomer.takeOver()).toBe("owner"); // no yield arrives: it waits the stale timeout
    expect(handed).toBe(1);
  });

  test("resume re-elects and closes a restored tab that finds another owner", async () => {
    const { create } = load();
    const bus = new FakeBus();
    let ownerHanded = 0;
    const owner = make(create, bus, { onTakeOver: () => (ownerHanded += 1) });
    expect(await owner.claim()).toBe(true);

    let restoredHanded = 0;
    const restored = make(create, bus, { onTakeOver: () => (restoredHanded += 1) });
    await restored.resume();
    expect(restoredHanded).toBe(0); // it got the origin
    expect(await restored.claim()).toBe(true);
    expect(ownerHanded).toBe(1);

    const lockedBus = new FakeBus();
    let lockedHanded = 0;
    const lockedOwner = make(create, lockedBus);
    expect(await lockedOwner.claim()).toBe(true);
    lockedOwner.setLocked(true);
    const refused = make(create, lockedBus, { onTakeOver: () => (lockedHanded += 1) });
    await refused.resume();
    expect(lockedHanded).toBe(1); // it did not get the origin, so it tries to close

    const padlocked = make(create, lockedBus, { onTakeOver: () => (lockedHanded += 1) });
    padlocked.setLocked(true);
    await padlocked.resume();
    expect(lockedHanded).toBe(1); // a padlocked restored tab does not ask and stays
  });

  test("the padlock starts open and is toggled per tab", () => {
    const { create } = load();
    const a = make(create, new FakeBus());
    const b = make(create, new FakeBus());
    expect(a.isLocked()).toBe(false);
    expect(b.isLocked()).toBe(false);
    a.setLocked(true);
    expect(a.isLocked()).toBe(true);
    expect(b.isLocked()).toBe(false);
    a.setLocked(false);
    expect(a.isLocked()).toBe(false);
  });

  test("the source keeps the protocol", () => {
    for (const needle of [
      "BroadcastChannel",
      "wip-web.tabs",
      'type: "claim"',
      'type: "beat"',
      'type: "yield"',
      'type: "deny"',
      'type: "bye"',
      "HEARTBEAT_MS",
      "STALE_MS",
      "release",
      "takeOver",
      "onTakeOver",
      "setLocked",
      "isLocked",
    ]) {
      expect({ needle, found: SOURCE.includes(needle) }).toEqual({ needle, found: true });
    }
    for (const gone of [
      "navigator.locks",
      "ifAvailable",
      "wip-web:tab",
      "localStorage",
      "sessionStorage",
      "wip-web:item:",
      "notifyOpen",
      "crypto.randomUUID",
      'type: "takeover"',
      'type: "yielded"',
      'type: "locked"',
    ]) {
      expect({ gone, found: SOURCE.includes(gone) }).toEqual({ gone, found: false });
    }
  });
});
