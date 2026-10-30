// The CLI is the only source of time: callers never pass event times by hand.
let override: Date | null = null;

/** Test-only: pin the clock (null restores the real one). Not reachable from the command line. */
export function setClockForTests(date: Date | null): void {
  override = date;
}

export function now(): Date {
  return override ? new Date(override.getTime()) : new Date();
}

/** UTC ISO with seconds, no milliseconds: 2026-10-20T10:14:56Z. */
export function iso(date: Date = now()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** `20261020T101456Z`, for file names. */
export function compact(date: Date = now()): string {
  return iso(date).replace(/[-:]/g, "");
}

export function parseIso(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z$/.test(value)) {
    throw new Error(`not a UTC ISO time: ${value}`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`not a UTC ISO time: ${value}`);
  return date;
}
