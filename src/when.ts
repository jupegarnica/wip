import { parseIso } from "./clock.ts";
import { usage } from "./errors.ts";
import { parseCadence } from "./flow/parse.ts";

/** The `--at` grammar, for messages. */
export const WHEN_FORMS =
  "a UTC ISO time (2026-11-06T13:00:00Z), an ISO time with an offset (2026-11-06T14:00+01:00), a local time YYYY-MM-DD HH:MM, or +<N>m, +<N>h, +<N>d";

const REL_RE = /^\+([1-9][0-9]*)([mhd])$/;
const OFFSET_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?([+-])(\d{2}):(\d{2})$/;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

function validParts(y: number, mo: number, d: number, h: number, mi: number, s = 0): boolean {
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || s > 59 || d < 1) return false;
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= days;
}

/** Year, month, day, hour and minute of a match. */
function numbers(m: RegExpExecArray): [number, number, number, number, number] {
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
}

function fromOffset(m: RegExpExecArray, raw: string, option: string): Date {
  const [y, mo, d, h, mi] = numbers(m);
  const s = m[6] === undefined ? 0 : Number(m[6]);
  const oh = Number(m[8]);
  const om = Number(m[9]);
  if (!validParts(y, mo, d, h, mi, s) || oh > 23 || om > 59) {
    throw usage(`${option} '${raw}': not a valid date and time`);
  }
  const sign = m[7] === "-" ? -1 : 1;
  const utc = Date.UTC(y, mo - 1, d, h, mi, s);
  return new Date(utc - sign * (oh * 60 + om) * 60_000);
}

/**
 * A local `YYYY-MM-DD HH:MM` in the machine time zone. A time the clock skips (spring DST gap) is refused; an
 * ambiguous one (autumn) is the first of the two, as `Date` resolves it.
 */
function fromLocal(m: RegExpExecArray, raw: string, option: string): Date {
  const [y, mo, d, h, mi] = numbers(m);
  if (!validParts(y, mo, d, h, mi)) throw usage(`${option} '${raw}': not a valid date and time`);
  const date = new Date(y, mo - 1, d, h, mi, 0, 0);
  if (date.getHours() !== h || date.getMinutes() !== mi || date.getDate() !== d) {
    throw usage(
      `${option} '${raw}': that local time does not exist here (a daylight-saving change)`,
    );
  }
  return date;
}

/**
 * Parses the `--at` grammar against `at` (now) and returns a time strictly in the future: UTC ISO with `Z`, ISO
 * with an offset (seconds optional), local `YYYY-MM-DD HH:MM`, or `+<N>m|h|d`. Anything else, or a time that is not
 * in the future, is exit 2.
 */
export function parseWhen(raw: string, at: Date, option = "--at"): Date {
  let when: Date;
  const rel = REL_RE.exec(raw);
  const offset = OFFSET_RE.exec(raw);
  const local = LOCAL_RE.exec(raw);
  if (rel) {
    when = new Date(at.getTime() + Number(rel[1]) * UNIT_MS[rel[2] as keyof typeof UNIT_MS]);
  } else if (offset) {
    when = fromOffset(offset, raw, option);
  } else if (local) {
    when = fromLocal(local, raw, option);
  } else {
    try {
      when = parseIso(raw);
    } catch {
      throw usage(`${option} '${raw}': ${WHEN_FORMS}`);
    }
  }
  if (when.getTime() <= at.getTime()) throw usage(`${option} '${raw}' is not in the future`);
  return when;
}

/** `--every`: the flows' cadence grammar (`30m`, `1h`, `7d`); exit 2 otherwise. */
export function parseEvery(raw: string, option = "--every"): string {
  if (parseCadence(raw) === null) {
    throw usage(`${option} '${raw}': a number and m, h or d (30m, 1h, 7d)`);
  }
  return raw;
}

/** One step of `every` from `at`: `d` moves local calendar days (14:00 stays 14:00 across DST), `m` and `h` absolute time. */
export function step(at: Date, every: string): Date {
  const m = /^([1-9][0-9]*)(m|h|d)$/.exec(every);
  if (!m) throw new Error(`not a cadence: ${every}`);
  const n = Number(m[1]);
  if (m[2] === "d") {
    const next = new Date(at.getTime());
    next.setDate(next.getDate() + n);
    return next;
  }
  return new Date(at.getTime() + n * UNIT_MS[m[2] as "m" | "h"]);
}

/**
 * The next occurrence of a repeating job after the one at `at`: at least one step, then the first one after `now`,
 * so missed occurrences are skipped and the result is never in the past.
 */
export function advance(at: Date, every: string, now: Date): Date {
  let next = step(at, every);
  const m = /^([1-9][0-9]*)(m|h)$/.exec(every);
  if (m && next.getTime() <= now.getTime()) {
    const size = Number(m[1]) * UNIT_MS[m[2] as "m" | "h"];
    const skip = Math.ceil((now.getTime() - next.getTime() + 1) / size);
    next = new Date(next.getTime() + skip * size);
  }
  while (next.getTime() <= now.getTime()) next = step(next, every);
  return next;
}

const pad = (n: number): string => String(n).padStart(2, "0");

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** The local minute of `at`: `at_local` (`YYYY-MM-DD HH:MM`), its weekday and a 5-field cron expression for it. */
export function localMinute(at: Date): { at_local: string; weekday: string; cron: string } {
  const y = at.getFullYear();
  const mo = at.getMonth() + 1;
  const d = at.getDate();
  const h = at.getHours();
  const mi = at.getMinutes();
  return {
    at_local: `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}`,
    weekday: WEEKDAYS[at.getDay()] as string,
    cron: `${mi} ${h} ${d} ${mo} *`,
  };
}
