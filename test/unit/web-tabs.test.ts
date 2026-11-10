import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const REPO = join(import.meta.dir, "..", "..");
const SOURCE = readFileSync(join(REPO, "web", "tabs.js"), "utf8");
const LOCK_NAME = "wip-web:tab";
const CHANNEL_NAME = "wip-web.tabs";

type TCreate = (options?: Record<string, unknown>) => {
  claim: () => Promise<boolean>;
  release: () => Promise<void>;
  setLocked: (value: boolean) => void;
  isLocked: () => boolean;
  takeOver: () => Promise<"owner" | "locked" | "unavailable">;
};

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

/**
 * navigator.locks with the shape tabs.js uses: `ifAvailable` never queues, a held name is a miss,
 * and the promise of `request` resolves only after the callback's promise, i.e. after the release.
 */
class FakeLocks {
  readonly held = new Set<string>();

  hold(name: string): void {
    this.held.add(name);
  }

  request(
    name: string,
    _options: { ifAvailable?: boolean } | undefined,
    callback: (lock: object | null) => unknown,
  ): Promise<unknown> {
    if (this.held.has(name)) return Promise.resolve(callback(null));
    this.held.add(name);
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(callback({}));
    } catch (error) {
      this.held.delete(name);
      return Promise.reject(error);
    }
    return result.then(
      (value) => {
        this.held.delete(name);
        return value;
      },
      (error) => {
        this.held.delete(name);
        throw error;
      },
    );
  }
}

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

/** The owner publishes `yielded` and the channel throws on it, as a closed BroadcastChannel would. */
class YieldThrowingChannel extends FakeChannel {
  override postMessage(data: unknown): void {
    if ((data as { type?: string })?.type === "yielded") throw new Error("closed");
    super.postMessage(data);
  }
}

describe("wip web tabs (F-WEB-10)", () => {
  test("one owner per origin, and claim takes no item", async () => {
    const { create } = load();
    const locks = new FakeLocks();
    const first = create({ locks, Channel: null });
    const second = create({ locks, Channel: null });
    expect(await first.claim()).toBe(true);
    expect(await second.claim()).toBe(false);
    expect(first.claim.length).toBe(0);
  });

  test("simultaneous claims give exactly one owner", async () => {
    const { create } = load();
    const locks = new FakeLocks();
    const a = create({ locks, Channel: null });
    const b = create({ locks, Channel: null });
    const owners = await Promise.all([a.claim(), b.claim()]);
    expect(owners.filter(Boolean)).toHaveLength(1);
  });

  test("without Web Locks every tab owns the origin and cannot ask", async () => {
    const { create } = load();
    const a = create({ locks: null, Channel: null });
    const b = create({ locks: null, Channel: null });
    expect(await a.claim()).toBe(true);
    expect(await b.claim()).toBe(true);
    expect(await create({ locks: null, Channel: null }).takeOver()).toBe("unavailable");
  });

  test("without BroadcastChannel a secondary cannot ask, so it must not close", async () => {
    const { create } = load();
    const locks = new FakeLocks();
    const owner = create({ locks, Channel: null });
    const other = create({ locks, Channel: null });
    expect(await owner.claim()).toBe(true);
    expect(await other.claim()).toBe(false);
    expect(await other.takeOver()).toBe("unavailable");
  });

  test("release frees the lock, and a release without the lock has no effect", async () => {
    const { create } = load();
    const locks = new FakeLocks();
    const a = create({ locks, Channel: null });
    const b = create({ locks, Channel: null });
    expect(await a.claim()).toBe(true);
    expect(await b.claim()).toBe(false);
    await b.release();
    expect(locks.held.has(LOCK_NAME)).toBe(true);
    await a.release();
    expect(locks.held.has(LOCK_NAME)).toBe(false);
    const c = create({ locks, Channel: null });
    expect(await c.claim()).toBe(true);
  });

  test("a takeover frees the lock, calls onTakeOver once and the new tab owns it", async () => {
    const { create } = load();
    const locks = new FakeLocks();
    const bus = new FakeBus();
    const Channel = channelOn(bus);
    let handed = 0;
    let freeInCallback = false;
    const owner = create({
      locks,
      Channel,
      handoverMs: 10,
      onTakeOver: () => {
        handed += 1;
        freeInCallback = locks.held.size === 0;
      },
    });
    const newcomer = create({ locks, Channel, handoverMs: 10 });
    expect(await owner.claim()).toBe(true);
    expect(await newcomer.claim()).toBe(false);
    expect(await newcomer.takeOver()).toBe("owner");
    expect(handed).toBe(1);
    expect(freeInCallback).toBe(true);
    expect(await newcomer.claim()).toBe(true);
    const third = create({ locks, Channel });
    expect(await third.claim()).toBe(false);
  });

  test("two simultaneous takeovers leave one owner and hand over once", async () => {
    const { create } = load();
    const locks = new FakeLocks();
    const bus = new FakeBus();
    const Channel = channelOn(bus);
    let handed = 0;
    const owner = create({ locks, Channel, handoverMs: 10, onTakeOver: () => (handed += 1) });
    const first = create({ locks, Channel, handoverMs: 10 });
    const second = create({ locks, Channel, handoverMs: 10 });
    expect(await owner.claim()).toBe(true);
    expect(await first.claim()).toBe(false);
    expect(await second.claim()).toBe(false);
    const results = await Promise.all([first.takeOver(), second.takeOver()]);
    expect(results.filter((result) => result === "owner")).toHaveLength(1);
    expect(handed).toBe(1);
  });

  test("a frozen owner never answers and the newcomer falls back without hanging", async () => {
    const { create } = load();
    const locks = new FakeLocks();
    const bus = new FakeBus();
    const Channel = channelOn(bus);
    locks.hold(LOCK_NAME);
    const newcomer = create({ locks, Channel, handoverMs: 5 });
    expect(await newcomer.claim()).toBe(false);
    expect(await newcomer.takeOver()).toBe("unavailable");
    expect(locks.held.has(LOCK_NAME)).toBe(true);
  });

  test("foreign and malformed messages are ignored without throwing", async () => {
    const { create } = load();
    const locks = new FakeLocks();
    const bus = new FakeBus();
    const Channel = channelOn(bus);
    let handed = 0;
    const owner = create({ locks, Channel, handoverMs: 10, onTakeOver: () => (handed += 1) });
    expect(await owner.claim()).toBe(true);

    const sender = new Channel(CHANNEL_NAME);
    for (const data of [null, undefined, "text", 42, [], { type: "nope" }, { type: "yielded" }]) {
      sender.postMessage(data);
    }
    expect(handed).toBe(0);
    expect(locks.held.has(LOCK_NAME)).toBe(true);

    // A takeover received by a tab that is not the owner changes nothing.
    const bus2 = new FakeBus();
    const Channel2 = channelOn(bus2);
    const bystander = create({ locks, Channel: Channel2, onTakeOver: () => (handed += 1) });
    expect(await bystander.claim()).toBe(false);
    const sender2 = new Channel2(CHANNEL_NAME);
    sender2.postMessage({ type: "takeover" });
    expect(handed).toBe(0);
    expect(locks.held.has(LOCK_NAME)).toBe(true);
  });

  test("a channel that throws does not break the request nor the handover", async () => {
    const { create } = load();
    const locks = new FakeLocks();
    class BrokenChannel {
      onmessage: TListener | null = null;
      postMessage(): void {
        throw new Error("closed");
      }
    }
    const owner = create({ locks, Channel: BrokenChannel });
    const secondary = create({ locks, Channel: BrokenChannel });
    expect(await owner.claim()).toBe(true);
    expect(await secondary.claim()).toBe(false);
    expect(await secondary.takeOver()).toBe("unavailable");

    const locks2 = new FakeLocks();
    const bus = new FakeBus();
    const Channel = channelOn(bus, YieldThrowingChannel);
    let handed = 0;
    const owner2 = create({
      locks: locks2,
      Channel,
      handoverMs: 10,
      onTakeOver: () => (handed += 1),
    });
    const newcomer = create({ locks: locks2, Channel, handoverMs: 5 });
    expect(await owner2.claim()).toBe(true);
    expect(await newcomer.claim()).toBe(false);
    expect(await newcomer.takeOver()).toBe("owner"); // no yielded: it timed out, then claimed the free lock
    expect(handed).toBe(1);
    expect(await newcomer.claim()).toBe(true);
  });

  test("the source keeps the handover protocol", () => {
    for (const needle of [
      "wip-web:tab",
      "wip-web.tabs",
      "ifAvailable: true",
      "release",
      "takeOver",
      "onTakeOver",
      "setLocked",
      "isLocked",
      'type: "takeover"',
      'type: "yielded"',
      'type: "locked"',
    ]) {
      expect({ needle, found: SOURCE.includes(needle) }).toEqual({ needle, found: true });
    }
    for (const gone of [
      "notifyOpen",
      "onOpen",
      'type: "open"',
      '"open-ack"',
      '"hello"',
      '"here"',
      "HELLO_MS",
      "tabId",
      "crypto.randomUUID",
      "wip-web:item:",
      "sessionStorage",
      "localStorage",
    ]) {
      expect({ gone, found: SOURCE.includes(gone) }).toEqual({ gone, found: false });
    }
  });

  test("a locked owner refuses the takeover at once and keeps the origin", async () => {
    const { create } = load();
    const locks = new FakeLocks();
    const bus = new FakeBus();
    const Channel = channelOn(bus);
    let handed = 0;
    const owner = create({ locks, Channel, onTakeOver: () => (handed += 1) });
    const newcomer = create({ locks, Channel });
    expect(await owner.claim()).toBe(true);
    owner.setLocked(true);
    // No handoverMs: a wait would return "unavailable" after 1 s, so "locked" proves it did not wait.
    expect(await newcomer.takeOver()).toBe("locked");
    expect(handed).toBe(0);
    expect(await newcomer.claim()).toBe(false);
    expect(await owner.claim()).toBe(true);
  });

  test("opening the padlock allows the handover", async () => {
    const { create } = load();
    const locks = new FakeLocks();
    const bus = new FakeBus();
    const Channel = channelOn(bus);
    let handed = 0;
    const owner = create({ locks, Channel, handoverMs: 10, onTakeOver: () => (handed += 1) });
    const newcomer = create({ locks, Channel, handoverMs: 10 });
    expect(await owner.claim()).toBe(true);
    owner.setLocked(true);
    expect(await newcomer.takeOver()).toBe("locked");
    owner.setLocked(false);
    expect(await newcomer.takeOver()).toBe("owner");
    expect(handed).toBe(1);
    expect(await newcomer.claim()).toBe(true);
  });

  test("the padlock starts open and is toggled per tab", () => {
    const { create } = load();
    const locks = new FakeLocks();
    const a = create({ locks, Channel: null });
    const b = create({ locks, Channel: null });
    expect(a.isLocked()).toBe(false);
    expect(b.isLocked()).toBe(false);
    a.setLocked(true);
    expect(a.isLocked()).toBe(true);
    expect(b.isLocked()).toBe(false);
    a.setLocked(false);
    expect(a.isLocked()).toBe(false);
  });

  test("a closed padlock in a tab that is not the owner changes nothing", async () => {
    const { create } = load();
    const locks = new FakeLocks();
    const bus = new FakeBus();
    const Channel = channelOn(bus);
    let handed = 0;
    const owner = create({ locks, Channel, handoverMs: 10, onTakeOver: () => (handed += 1) });
    const bystander = create({ locks, Channel, handoverMs: 10 });
    const third = create({ locks, Channel, handoverMs: 10 });
    expect(await owner.claim()).toBe(true);
    expect(await bystander.claim()).toBe(false);
    bystander.setLocked(true);
    expect(await third.claim()).toBe(false);
    expect(await third.takeOver()).toBe("owner");
    expect(handed).toBe(1);
    expect(await third.claim()).toBe(true);
    expect(await bystander.claim()).toBe(false);
  });
});
