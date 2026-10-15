-- 0024_aws_insights.sql
--
-- Plain English: what AWS says about the headend when it runs there, kept
-- for the same insight widgets as Azure's (0019). The collector's AWS feeds
-- (worker/src/insights/aws/) ask AWS on the insights cron and write here;
-- pages only ever read these tables, never AWS. Each table mirrors its az_*
-- twin so the read layer can answer the same response shapes.
--
-- Every new table is WITHOUT ROWID, like hist_*: a write is one row (D1
-- bills writes per row). Times are ISO UTC; history slots use hist_vm's
-- "YYYY-MM-DDTHH:MM:SSZ". Integer binds from the Worker are CAST (D1 binds
-- every JS number as REAL). None of these tables is in the R2 backup; the
-- dev seeder wipes them (AWS_TABLES in insights/aws/types.ts).
-- Spec: docs/superpowers/specs/2026-10-15-aws-insights-design.md, section 5.

-- CloudWatch's AWS/EC2 metrics for the headend, one wide row per 5-minute slot.
-- Column names match hist_az_vm where the meaning matches.
CREATE TABLE IF NOT EXISTS hist_aws_vm (
  res           INTEGER NOT NULL,  -- seconds per row: 300 only
  t             TEXT    NOT NULL,  -- start of the slot (UTC)
  cpu_avg       REAL,              -- CPUUtilization, Average (%)
  cpu_max       REAL,              -- CPUUtilization, Maximum (%)
  net_in        REAL,              -- NetworkIn, Sum / 300 (bytes per second over the slot)
  net_out       REAL,              -- NetworkOut, Sum / 300 (bytes per second over the slot)
  disk_read     REAL,              -- EBSReadBytes, Sum / 300 (bytes per second over the slot)
  disk_write    REAL,              -- EBSWriteBytes, Sum / 300 (bytes per second over the slot)
  disk_rops     REAL,              -- EBSReadOps, Sum / 300 (ops per second)
  disk_wops     REAL,              -- EBSWriteOps, Sum / 300 (ops per second)
  credits_min   REAL,              -- CPUCreditBalance, Minimum (credits)
  credits_used  REAL,              -- CPUCreditUsage, Sum (credits)
  status_failed REAL,              -- StatusCheckFailed, Maximum (0 or 1)
  pkts_in       REAL,              -- NetworkPacketsIn, Sum (packets in the slot)
  pkts_out      REAL,              -- NetworkPacketsOut, Sum (packets in the slot)
  PRIMARY KEY (res, t)
) WITHOUT ROWID;

-- One row per AWS feed ('aws.health', ..., 'aws.housekeeping'): when it last ran, last worked, and is next due.
CREATE TABLE IF NOT EXISTS aws_feed (
  feed        TEXT PRIMARY KEY,  -- an AwsFeedId (insights/aws/types.ts)
  last_try_at TEXT,
  last_ok_at  TEXT,
  status      TEXT NOT NULL,     -- ok | error | not_configured | skipped | idle
  error       TEXT,              -- the last error in plain words; never a URL, key or signature
  next_due_at TEXT
) WITHOUT ROWID;

-- The latest answer of the feeds that keep one document: 'health', 'bootlog', and the once-per-window markers.
CREATE TABLE IF NOT EXISTS aws_latest (
  key        TEXT PRIMARY KEY,
  json       TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

-- CloudTrail's write events that touch cloudlabs' AWS resources, one row per event.
CREATE TABLE IF NOT EXISTS aws_activity (
  id            TEXT PRIMARY KEY,  -- CloudTrail's EventId
  at            TEXT NOT NULL,     -- EventTime
  operation     TEXT NOT NULL,     -- EventName, e.g. AuthorizeSecurityGroupIngress
  status        TEXT NOT NULL,     -- Succeeded | Failed
  caller        TEXT,              -- IAM user name, role session name or AWS service
  caller_kind   TEXT NOT NULL,     -- wgadmin | person | aws
  resource_type TEXT NOT NULL,     -- plain name from AWS_RESOURCE_KINDS: EC2 instance, Security group, ... Other
  resource_name TEXT               -- the resource id
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS aws_activity_at ON aws_activity (at);

-- AWS's public status feed (RSS) items for EC2 and VPC in the region.
CREATE TABLE IF NOT EXISTS aws_service_events (
  tracking_id TEXT PRIMARY KEY,  -- the item's guid
  type        TEXT NOT NULL,     -- ServiceIssue | PlannedMaintenance
  status      TEXT NOT NULL,     -- Active | Resolved
  level       TEXT,
  title       TEXT NOT NULL,
  summary     TEXT,
  services    TEXT NOT NULL,     -- JSON array: ["EC2"] or ["VPC"]
  regions     TEXT NOT NULL,     -- JSON array of region display names ("London")
  starts_at   TEXT,
  ends_at     TEXT,
  updated_at  TEXT NOT NULL
) WITHOUT ROWID;

-- Region capacity and quota, the latest per region (JSON: a CapacityDoc).
CREATE TABLE IF NOT EXISTS aws_capacity (
  region     TEXT PRIMARY KEY,
  json       TEXT NOT NULL,
  fetched_at TEXT NOT NULL
) WITHOUT ROWID;

-- AWS list prices in GBP (converted from USD), the latest per region and item.
CREATE TABLE IF NOT EXISTS aws_prices (
  region     TEXT NOT NULL,
  item       TEXT NOT NULL,     -- an instance type (t4g.micro), 'disk:gp3' or 'ip:v4'
  gbp        REAL NOT NULL,     -- per unit
  unit       TEXT NOT NULL,     -- '1 Hour' or 'GB-Mo'
  meter      TEXT NOT NULL,     -- AWS's usagetype
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (region, item)
) WITHOUT ROWID;
