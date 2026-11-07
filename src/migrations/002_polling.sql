-- wip schema v2: polling. A pass never writes `events`; the cadence lives in the flow, not here.

CREATE TABLE poll_runs (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  flow   TEXT NOT NULL,
  poll   TEXT NOT NULL,
  agent  TEXT NOT NULL,
  ts     TEXT NOT NULL,
  result TEXT
) STRICT;
CREATE INDEX poll_runs_flow_poll_ts ON poll_runs(flow, poll, ts);

CREATE TABLE poll_run_items (
  run_id  INTEGER NOT NULL REFERENCES poll_runs(id),
  item_id TEXT NOT NULL REFERENCES items(id),
  PRIMARY KEY (run_id, item_id)
) STRICT;
CREATE INDEX poll_run_items_item ON poll_run_items(item_id);

CREATE TABLE poll_seen (
  flow    TEXT NOT NULL,
  poll    TEXT NOT NULL,
  key     TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  until   TEXT,
  note    TEXT,
  PRIMARY KEY (flow, poll, key)
) STRICT;
