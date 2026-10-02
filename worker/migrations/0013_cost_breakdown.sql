-- 0013_cost_breakdown.sql
--
-- Plain English: Azure's actual cost split by what it was spent on and where.
-- One row per day, per Azure service name (kept exactly as Azure says it,
-- for example "Virtual Machines" or "Bandwidth") and per location (lower
-- case without spaces, for example "uksouth"). The four groups the Cost page
-- shows (compute, network, disk, other) are worked out when the page is read,
-- so a change to the grouping needs no migration.
--
-- WITHOUT ROWID: each row lives in its key only, so a write is one row.
-- The key starts with the day, so reading a range and deleting old days both
-- use it and never read the whole table.

CREATE TABLE IF NOT EXISTS cost_breakdown (
  day        TEXT NOT NULL,  -- "YYYY-MM-DD" (UTC), as in cost_days
  category   TEXT NOT NULL,  -- Azure's service name, as reported
  location   TEXT NOT NULL,  -- Azure region id, e.g. "uksouth"; "" when Azure gave none
  gbp        REAL NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (day, category, location)
) WITHOUT ROWID;
