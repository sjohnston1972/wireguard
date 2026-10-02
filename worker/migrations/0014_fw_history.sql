-- 0014_fw_history.sql
--
-- Plain English: how often each firewall rule matched, over time. Every VM
-- heartbeat that reports firewall counters adds the increase since the
-- previous report to a one-minute row per rule that went up ("r12" for a
-- rule, "default" for the default action, "f3" for a published port).
-- Same housekeeping as the client history (0012): samples older than 48
-- hours are folded into 5-minute summaries, and anything older than 30
-- days is deleted. A rule that did not match in a minute has no row.
--
-- WITHOUT ROWID, like the other history tables: a row lives in its key
-- index only, so a write is one row, and the tidy-up and the reads search
-- by time without touching a second structure.

CREATE TABLE IF NOT EXISTS hist_fw (
  res     INTEGER NOT NULL,  -- seconds per row: 60 (raw) or 300 (5-minute summary)
  t       TEXT    NOT NULL,  -- start of the slot, "YYYY-MM-DDTHH:MM:SSZ" (UTC)
  rule    TEXT    NOT NULL,  -- the counter key: "r<id>", "default" or "f<id>"
  packets INTEGER NOT NULL,  -- packets that matched in this slot
  bytes   INTEGER NOT NULL,
  PRIMARY KEY (res, t, rule)  -- res and time first: the tidy-up reads by time range
) WITHOUT ROWID;
