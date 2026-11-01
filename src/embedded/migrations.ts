import init001 from "../migrations/001_init.sql" with { type: "text" };
import polling002 from "../migrations/002_polling.sql" with { type: "text" };

/** Ordered: index + 1 is the `user_version` each migration leaves behind. Keys are file names. */
export const MIGRATIONS: readonly (readonly [string, string])[] = [
  ["001_init.sql", init001],
  ["002_polling.sql", polling002],
];
