-- 0016_run_live_log.sql
--
-- Plain English: a run's live log. GitHub only hands out a job's log once
-- the job has finished, so while a deploy or tear-down runs, the workflow
-- posts its own output here a few seconds at a time (infra/ci/live-log.mjs,
-- POST /api/callback/log). Each piece is one row, numbered by the workflow
-- (seq), so a piece sent twice after a network blip is stored once. Secrets
-- are hidden on the runner before sending, and again by the Worker.
--
-- Kept small: the newest ~400 KB per run, and the watchman deletes a run's
-- rows 14 days after it ends. Once a run has finished the dashboard shows
-- GitHub's full log instead, and falls back to this copy only when GitHub
-- has none.
--
-- WITHOUT ROWID: each row lives in its key index only (one write, not two).

CREATE TABLE IF NOT EXISTS run_live_log (
  run_id TEXT    NOT NULL,  -- runs.id
  seq    INTEGER NOT NULL,  -- the workflow's piece number, 1, 2, 3...
  at     TEXT    NOT NULL,  -- when the Worker received it (ISO, UTC)
  text   TEXT    NOT NULL,  -- whole lines, each "<ISO time> <text>", as GitHub writes its own log
  PRIMARY KEY (run_id, seq)
) WITHOUT ROWID;
