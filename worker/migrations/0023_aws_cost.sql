-- 0023_aws_cost.sql
--
-- Plain English: what AWS actually billed for the headend, one row per day.
-- Cost Explorer answers in dollars; the Worker stores both the dollars and
-- the pounds it converted with AWS_USD_GBP. Azure's figures stay in cost_days.

CREATE TABLE aws_cost_days (
  day TEXT PRIMARY KEY,
  gbp REAL NOT NULL,
  usd REAL NOT NULL,
  fetched_at TEXT NOT NULL
);
