-- wip schema v1. Times are UTC ISO strings with seconds (clock.ts). STRICT tables need SQLite >= 3.37.

CREATE TABLE flows (
  name      TEXT PRIMARY KEY,
  path      TEXT NOT NULL,
  hash      TEXT NOT NULL,
  json      TEXT NOT NULL CHECK (json_valid(json)),
  loaded_at TEXT NOT NULL
) STRICT;

CREATE TABLE items (
  id           TEXT PRIMARY KEY,
  flow         TEXT NOT NULL,
  title        TEXT,
  phase        TEXT NOT NULL,
  waiting_on   TEXT,
  next         TEXT,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'archived')),
  artifact_dir TEXT,
  fields       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fields) AND json_type(fields) = 'object'),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  archived_at  TEXT
) STRICT;
CREATE INDEX items_flow_status ON items(flow, status);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at   TEXT
) STRICT;

CREATE TABLE events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT REFERENCES items(id),
  ts      TEXT NOT NULL,
  phase   TEXT,
  kind    TEXT NOT NULL CHECK (kind IN ('phase', 'wait', 'set', 'agent_start', 'agent_stop',
                                        'gate_open', 'gate_close', 'user', 'note', 'milestone',
                                        'correction', 'archive', 'session')),
  actor   TEXT,
  text    TEXT,
  data    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data))
) STRICT;
CREATE INDEX events_item_ts ON events(item_id, ts);

CREATE TABLE agent_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     TEXT NOT NULL REFERENCES items(id),
  phase       TEXT NOT NULL,
  agent       TEXT NOT NULL,
  handle      TEXT,
  session_id  TEXT REFERENCES sessions(id),
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL DEFAULT 'running'
              CHECK (status IN ('running', 'done', 'blocked', 'needs-input', 'stopped', 'orphaned')),
  duration_s  INTEGER,
  summary     TEXT
) STRICT;
CREATE INDEX agent_runs_status ON agent_runs(status);
CREATE INDEX agent_runs_item ON agent_runs(item_id);

CREATE TABLE gates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     TEXT NOT NULL REFERENCES items(id),
  phase       TEXT NOT NULL,
  opened_at   TEXT NOT NULL,
  closed_at   TEXT,
  question    TEXT,
  detail_path TEXT,
  answer      TEXT,
  decision    TEXT
) STRICT;
CREATE INDEX gates_item_open ON gates(item_id, closed_at);
