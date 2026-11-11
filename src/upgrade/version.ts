/**
 * SemVer 2 comparison, without a dependency: the package ships none. `parseVersion` accepts `X.Y.Z` and a
 * prerelease (`0.3.0-next.1`); build metadata is not accepted, because npm dist-tags never carry it and a value
 * wip cannot compare is a refusal, not a guess.
 */

export interface IVersion {
  major: number;
  minor: number;
  patch: number;
  /** Numeric identifiers as numbers, alphanumeric ones as strings; empty for a release. */
  prerelease: readonly (string | number)[];
}

const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseVersion(text: string): IVersion | null {
  const match = VERSION_RE.exec(text);
  if (match === null) return null;
  const raw = match[4];
  const prerelease =
    raw === undefined
      ? []
      : raw.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function comparePre(
  left: readonly (string | number)[],
  right: readonly (string | number)[],
): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1; // a release is above its prereleases
  if (right.length === 0) return -1;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const a = left[i];
    const b = right[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumber = typeof a === "number";
    const bNumber = typeof b === "number";
    if (aNumber && bNumber) return a < b ? -1 : 1;
    if (aNumber) return -1; // numeric identifiers rank below alphanumeric ones
    if (bNumber) return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

/** -1, 0 or 1; throws on a value that is not a version, naming it so the command can refuse it. */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  if (a === null) throw new Error(`not a version: ${left}`);
  const b = parseVersion(right);
  if (b === null) throw new Error(`not a version: ${right}`);
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePre(a.prerelease, b.prerelease);
}

export function isNewer(target: string, current: string): boolean {
  return compareVersions(target, current) > 0;
}
