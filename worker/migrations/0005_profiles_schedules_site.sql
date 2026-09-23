-- 0005_profiles_schedules_site.sql
--
-- Plain English: four additions.
--   profiles    named deploy presets ("UK", "US exit"): where and how big
--   schedules   "up on these days between these times", run by the watchman
--   speedtests  results of the tunnel speed test, Azure <-> home
--   peers.routes    extra networks reached THROUGH a peer: the home site's LAN
--   peers.home_lan  whether a client's config sends the home LAN into the tunnel

CREATE TABLE IF NOT EXISTS profiles (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL UNIQUE,
  region   TEXT NOT NULL,
  vm_size  TEXT NOT NULL,
  sort     INTEGER NOT NULL DEFAULT 0
);

INSERT INTO profiles (name, region, vm_size, sort) VALUES
  ('UK', 'uksouth', 'Standard_B1s', 1),
  ('US exit', 'eastus', 'Standard_B1s', 2),
  ('EU exit', 'westeurope', 'Standard_B1s', 3);

CREATE TABLE IF NOT EXISTS schedules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  days        TEXT NOT NULL,              -- ISO weekdays, e.g. "12345" = Monday to Friday
  start_time  TEXT NOT NULL,              -- "08:00", Europe/London
  end_time    TEXT NOT NULL,              -- "18:00", later than start_time
  profile_id  INTEGER,                    -- null = the usual settings
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS speedtests (
  id          TEXT PRIMARY KEY,
  at          TEXT NOT NULL,
  target_name TEXT,
  down_mbps   REAL,                       -- Azure -> home
  up_mbps     REAL,                       -- home -> Azure
  rtt_ms      REAL,
  jitter_ms   REAL,
  error       TEXT
);

ALTER TABLE peers ADD COLUMN routes TEXT NOT NULL DEFAULT '';
ALTER TABLE peers ADD COLUMN home_lan INTEGER NOT NULL DEFAULT 0;
