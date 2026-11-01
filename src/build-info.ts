import pkg from "../package.json" with { type: "json" };

/** Fixed into the compiled binary by `scripts/build.ts` (`bun build --define`): a JSON string. Absent from source runs. */
declare const WIP_BUILD_INFO: string | undefined;

export interface IBuildInfo {
  /** `package.json`, always. */
  version: string;
  /** True when the code does not come from a binary compiled by `scripts/build.ts`. */
  source: boolean;
  /** Null: source run, detached HEAD or no git. */
  branch: string | null;
  /** `git rev-parse --short HEAD`. Null: source run or no git. */
  commit: string | null;
  /** Null: source run or no git. */
  dirty: boolean | null;
  /** ISO 8601 UTC, seconds. Null: source run. */
  built_at: string | null;
}

const orNull = (value: unknown, type: "string" | "boolean"): string | boolean | null =>
  typeof value === type ? (value as string | boolean) : null;

/** Never throws: `--version` must always answer. A missing or malformed define gives the source shape. */
export function parseBuildInfo(version: string, raw: string | undefined): IBuildInfo {
  const info: IBuildInfo = {
    version,
    source: true,
    branch: null,
    commit: null,
    dirty: null,
    built_at: null,
  };
  if (raw === undefined) return info;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return info;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return info;
  const fields = parsed as Record<string, unknown>;
  const builtAt = orNull(fields.built_at, "string") as string | null;
  if (builtAt === null) return info;
  return {
    version,
    source: false,
    branch: orNull(fields.branch, "string") as string | null,
    commit: orNull(fields.commit, "string") as string | null,
    dirty: orNull(fields.dirty, "boolean") as boolean | null,
    built_at: builtAt,
  };
}

export function formatBuildInfo(info: IBuildInfo): string {
  if (info.source || info.built_at === null) return `${info.version} (source)`;
  const where =
    info.commit === null
      ? "no git"
      : `${info.branch ?? "detached"} ${info.commit}${info.dirty ? "-dirty" : ""}`;
  return `${info.version} (${where}, built ${info.built_at})`;
}

export const BUILD_INFO: IBuildInfo = parseBuildInfo(
  pkg.version,
  typeof WIP_BUILD_INFO === "string" ? WIP_BUILD_INFO : undefined,
);
