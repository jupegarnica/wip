-- wip schema v4: scheduled jobs. Additive: no row of another table changes.
-- A reminder has text and no flow nor poll; a poll pass names a declared poll. `at` is UTC ISO; `every` a cadence.

CREATE TABLE crons (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL CHECK (kind IN ('reminder', 'poll')),
  text       TEXT CHECK (text IS NULL OR length(text) BETWEEN 1 AND 500),
  flow       TEXT,
  poll       TEXT,
  at         TEXT NOT NULL,
  every      TEXT,
  item_id    TEXT REFERENCES items(id),
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  created_at TEXT NOT NULL,
  closed_at  TEXT,
  CHECK ((kind = 'reminder' AND text IS NOT NULL AND flow IS NULL AND poll IS NULL)
      OR (kind = 'poll' AND flow IS NOT NULL AND poll IS NOT NULL))
) STRICT;
CREATE INDEX crons_status_at ON crons(status, at);
