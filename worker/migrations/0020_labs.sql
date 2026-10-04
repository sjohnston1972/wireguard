-- 0020_labs.sql
--
-- Plain English: on-demand lab environments (spec
-- docs/superpowers/specs/2026-10-04-labs-design.md, section 7.1). A lab
-- session is one deploy of one lab, from Deploy until Azure is clean again;
-- each workflow run for it (deploy, destroy, peer, unpeer, test) is a
-- lab_runs row. Nothing is added to runs: its action CHECK allows only apply
-- and destroy, and SQLite cannot alter a CHECK.
--
-- The lab address pool 10.64.0.0/13 is 32 slots of /18 (section 4). A
-- session holds one slot from deploy until Azure is clean, so two labs never
-- share addresses. Slot n is 10.64.0.0 + n x 16384: the second octet is
-- 64 + n / 4 and the third (n % 4) x 64. Reserve with one statement:
--   UPDATE lab_slots SET session_id = ?1, since = ?2
--   WHERE slot = (SELECT MIN(slot) FROM lab_slots WHERE session_id IS NULL)
--     AND session_id IS NULL RETURNING slot, cidr
--
-- Times are ISO UTC. Integer binds from the Worker are CAST (D1 binds every
-- JS number as REAL). The catalogue itself is not here: it is bundled with
-- the Worker (shared/labs.generated.json). None of these tables is in the R2
-- backup; the dev seeder wipes them, and only its labs story fills them.

CREATE TABLE IF NOT EXISTS lab_sessions (
  id               TEXT PRIMARY KEY,     -- "ls-<stamp>-<rand>"
  lab_id           TEXT NOT NULL,
  lab_version      INTEGER NOT NULL,
  state            TEXT NOT NULL,        -- deploying | running | failed | tearing_down | ended | ended_dirty
  test             INTEGER NOT NULL DEFAULT 0,  -- 1 = a release test (section 11.2)
  region           TEXT NOT NULL,
  secondary_region TEXT,
  slot             INTEGER,
  cidr             TEXT,
  name_prefix      TEXT NOT NULL,        -- "l" + lab number + 5 lowercase characters
  peering          TEXT NOT NULL,        -- off | waiting | on | disconnected
  requested_at     TEXT NOT NULL,
  ready_at         TEXT,
  ended_at         TEXT,
  auto_destroy_at  TEXT,                 -- ready_at + hours, never later than max_until
  max_until        TEXT NOT NULL,        -- requested_at + max_h: nothing moves this
  warned_at        TEXT,                 -- the 15-minute push went out
  est_gbp_h        REAL NOT NULL,        -- the estimate per hour at deploy
  est_gbp          REAL,                 -- the estimate for the whole session, on end
  end_reason       TEXT,                 -- manual | timer | max | budget | failed | orphan | test
  outputs_json     TEXT,                 -- { private_ips, connect, users, peer_vnet_id }
  leftovers_json   TEXT,                 -- what the clean check found (ended_dirty)
  note             TEXT                  -- the operator's note, at most 2000 characters
);
CREATE INDEX IF NOT EXISTS lab_sessions_lab ON lab_sessions (lab_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS lab_sessions_state ON lab_sessions (state);

CREATE TABLE IF NOT EXISTS lab_runs (
  id                  TEXT PRIMARY KEY,  -- "lab-<action>-<stamp>-<rand>", also the run_live_log key
  session_id          TEXT NOT NULL,
  lab_id              TEXT NOT NULL,
  action              TEXT NOT NULL,     -- deploy | destroy | peer | unpeer | test
  status              TEXT NOT NULL,     -- queued | running | succeeded | failed | cancelled
  requested_at        TEXT NOT NULL,
  requested_by        TEXT,
  reason              TEXT,
  started_at          TEXT,
  finished_at         TEXT,
  github_run_id       INTEGER,
  github_run_url      TEXT,
  callback_token_hash TEXT,
  admin_password      TEXT,              -- cleared when the session ends, like runs.ssh_password
  payload_json        TEXT,
  outputs_json        TEXT,
  steps_json          TEXT,
  error               TEXT
);
CREATE INDEX IF NOT EXISTS lab_runs_session ON lab_runs (session_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS lab_runs_requested ON lab_runs (requested_at DESC);

CREATE TABLE IF NOT EXISTS lab_slots (
  slot       INTEGER PRIMARY KEY,
  cidr       TEXT NOT NULL,
  session_id TEXT,                       -- NULL = free
  since      TEXT
) WITHOUT ROWID;

-- Azure's daily cost per lab resource group (section 9.4), from one unfiltered
-- Cost Management query grouped by ResourceGroupName.
CREATE TABLE IF NOT EXISTS lab_cost_days (
  day        TEXT NOT NULL,              -- YYYY-MM-DD
  rg         TEXT NOT NULL,              -- rg-lab-<id> or rg-lab-<id>-<suffix>
  lab_id     TEXT NOT NULL,
  gbp        REAL NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (day, rg)
) WITHOUT ROWID;

-- One row per real-Azure release test (section 11.2). result: pass | fail
-- (pass needs a clean tear-down, so an empty leftovers list).
CREATE TABLE IF NOT EXISTS lab_release_tests (
  lab_id          TEXT NOT NULL,
  version         INTEGER NOT NULL,
  at              TEXT NOT NULL,
  run_id          TEXT NOT NULL,
  result          TEXT NOT NULL,
  deploy_seconds  INTEGER,
  destroy_seconds INTEGER,
  est_gbp         REAL,
  leftovers_json  TEXT,
  PRIMARY KEY (lab_id, version, at)
) WITHOUT ROWID;

-- The 32 slots, seeded once.
INSERT OR IGNORE INTO lab_slots (slot, cidr)
WITH RECURSIVE n(slot) AS (SELECT 0 UNION ALL SELECT slot + 1 FROM n WHERE slot < 31)
SELECT slot, '10.' || (64 + slot / 4) || '.' || ((slot % 4) * 64) || '.0/18' FROM n;

-- Clients whose "Azure route" switch is on now also route the lab pool
-- (section 7.6), so their config is out of date until they fetch it again.
-- Only split-tunnel clients: a full-tunnel config already sends everything,
-- and a site's AllowedIPs are its own routes.
ALTER TABLE peers ADD COLUMN labs_config_due INTEGER NOT NULL DEFAULT 0;
UPDATE peers SET labs_config_due = 1 WHERE azure_vnet = 1 AND full_tunnel = 0 AND COALESCE(routes, '') = '';
