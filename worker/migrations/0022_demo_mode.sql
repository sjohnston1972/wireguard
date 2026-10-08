-- 0022_demo_mode.sql
--
-- Plain English: who is looking at demo data (demo mode spec §3 ruling 5).
-- One row per person who switched demo mode on; no row means real data. The
-- Worker reads it on every request, so the switch takes effect at once
-- everywhere (D1, not KV, which can serve a stale copy for a minute). It is
-- the only real-store write demo mode makes. Cosmetic like ui_prefs: never in
-- the backup export, restore, audit log or Activity, and the dev seeder never
-- wipes it.

CREATE TABLE IF NOT EXISTS demo_mode (
  user  TEXT PRIMARY KEY,        -- Access identity email, lower case (c.get("user"))
  since TEXT NOT NULL            -- ISO, UTC: when this person switched it on
) WITHOUT ROWID;
