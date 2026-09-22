-- 0001_init.sql
--
-- Plain English: the dashboard's record books. Five tables:
--   runs      every deploy and destroy ever requested, with timings and result
--   peers     the clients (phones, laptops) allowed on the tunnel
--   alerts    things the watchdog noticed while nobody was looking
--   settings  small key/value overrides changed from the Settings page
--   cost_days actual daily spend pulled from Azure Cost Management

CREATE TABLE IF NOT EXISTS runs (
  id                  TEXT PRIMARY KEY,
  action              TEXT NOT NULL CHECK (action IN ('apply', 'destroy')),
  status              TEXT NOT NULL,            -- queued | running | success | failure | cancelled
  requested_at        TEXT NOT NULL,
  requested_by        TEXT,
  started_at          TEXT,
  finished_at         TEXT,
  github_run_id       INTEGER,
  github_run_url      TEXT,
  callback_token_hash TEXT,
  agent_token_hash    TEXT,
  payload_json        TEXT,
  outputs_json        TEXT,
  public_ip           TEXT,
  auto_destroy_at     TEXT,
  reason              TEXT,
  error               TEXT
);

CREATE INDEX IF NOT EXISTS runs_requested_at ON runs (requested_at DESC);

CREATE TABLE IF NOT EXISTS peers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  public_key  TEXT NOT NULL UNIQUE,
  ip          TEXT NOT NULL UNIQUE,
  enabled     INTEGER NOT NULL DEFAULT 1,
  full_tunnel INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  note        TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at           TEXT NOT NULL,
  kind         TEXT NOT NULL,   -- deploy | destroy | failure | drift | cost_guard | idle | unreachable | info
  message      TEXT NOT NULL,
  run_id       TEXT,
  acknowledged INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS alerts_at ON alerts (at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cost_days (
  day        TEXT PRIMARY KEY,   -- YYYY-MM-DD
  gbp        REAL NOT NULL,
  fetched_at TEXT NOT NULL
);
