-- 0017_run_live_log_pruned.sql
--
-- Plain English: which runs' live logs have had their oldest pieces dropped
-- to stay under the per-run cap (livelog.ts, db.trimLiveLog), and up to which
-- piece. The dashboard says "Earlier lines were dropped" only for these. A
-- missing piece 1 is not enough to tell: the Worker turns away a piece that
-- is too big (413) and the runner skips it, so a log can start at piece 2
-- with nothing ever dropped.
--
-- Deleted with the run's live log by the watchman (db.pruneLiveLogs).

CREATE TABLE IF NOT EXISTS run_live_log_pruned (
  run_id TEXT    NOT NULL PRIMARY KEY,  -- runs.id
  upto   INTEGER NOT NULL               -- the highest piece number dropped
) WITHOUT ROWID;
