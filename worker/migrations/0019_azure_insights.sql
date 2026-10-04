-- 0019_azure_insights.sql
--
-- Plain English: what Azure and the VM itself say about the headend, kept
-- for the new (off-by-default) insight widgets. The collector (a second
-- cron, worker/src/insights/) asks Azure every few minutes and writes here;
-- pages only ever read these tables, never Azure. The VM's own vitals arrive
-- with the heartbeat and add six columns to hist_vm.
--
-- Every new table is WITHOUT ROWID, like hist_*: a write is one row (D1
-- bills writes per row). Times are ISO UTC; history slots use hist_vm's
-- "YYYY-MM-DDTHH:MM:SSZ". Integer binds from the Worker are CAST (D1 binds
-- every JS number as REAL). None of these tables is in the R2 backup; the
-- dev seeder wipes them, and only its `insights` story fills them.
-- Spec: docs/superpowers/specs/2026-10-04-azure-insights-design.md, section 6.

-- The VM's vitals, per heartbeat sample (rolled up like the rest of hist_vm).
ALTER TABLE hist_vm ADD COLUMN mem_used_pct  REAL;  -- (total - available) / total, %
ALTER TABLE hist_vm ADD COLUMN disk_used_pct REAL;  -- of /, %
ALTER TABLE hist_vm ADD COLUMN steal_pct     REAL;  -- CPU steal since the last heartbeat, % (roll-up keeps the max)
ALTER TABLE hist_vm ADD COLUMN conntrack_pct REAL;  -- nf_conntrack count / max, %
ALTER TABLE hist_vm ADD COLUMN net_rtt_ms    REAL;  -- internet check: mean round trip of the targets that answered
ALTER TABLE hist_vm ADD COLUMN net_loss_pct  REAL;  -- internet check: mean loss over the targets, % (roll-up keeps the max)

-- Azure Monitor platform metrics for vm-wg, one wide row per 5-minute slot.
CREATE TABLE IF NOT EXISTS hist_az_vm (
  res          INTEGER NOT NULL,  -- seconds per row: 300 only
  t            TEXT    NOT NULL,  -- start of the slot (UTC)
  cpu_avg      REAL,              -- Percentage CPU, Average (%)
  cpu_max      REAL,              -- Percentage CPU, Maximum (%)
  mem_free_min REAL,              -- Available Memory Bytes, Minimum (bytes)
  net_in       REAL,              -- Network In Total (bytes per second over the slot)
  net_out      REAL,              -- Network Out Total (bytes per second over the slot)
  disk_read    REAL,              -- Disk Read Bytes (bytes per second over the slot)
  disk_write   REAL,              -- Disk Write Bytes (bytes per second over the slot)
  disk_rops    REAL,              -- Disk Read Operations/Sec, Average
  disk_wops    REAL,              -- Disk Write Operations/Sec, Average
  credits_min  REAL,              -- CPU Credits Remaining, Minimum
  credits_used REAL,              -- CPU Credits Consumed, Total
  avail_avg    REAL,              -- VmAvailabilityMetric, Average (0..1)
  os_iops_max  REAL,              -- OS Disk IOPS Consumed Percentage, Maximum (%)
  os_bw_max    REAL,              -- OS Disk Bandwidth Consumed Percentage, Maximum (%)
  PRIMARY KEY (res, t)
) WITHOUT ROWID;

-- Azure Monitor platform metrics for pip-wg (the IPv4 public IP), one wide row per 5-minute slot.
CREATE TABLE IF NOT EXISTS hist_az_pip (
  res             INTEGER NOT NULL,  -- seconds per row: 300 only
  t               TEXT    NOT NULL,
  ddos_max        REAL,              -- IfUnderDDoSAttack, Maximum (0 or 1)
  pkts_in_ddos    REAL,              -- PacketsInDDoS, Maximum (per second)
  pkts_drop_ddos  REAL,              -- PacketsDroppedDDoS, Maximum (per second)
  bytes_in_ddos   REAL,              -- BytesInDDoS, Maximum (per second)
  bytes_drop_ddos REAL,              -- BytesDroppedDDoS, Maximum (per second)
  packets         REAL,              -- PacketCount, Total (in the slot)
  bytes           REAL,              -- ByteCount, Total (in the slot)
  syn             REAL,              -- SynCount, Total (in the slot)
  vip_avail       REAL,              -- VipAvailability, Average (%)
  PRIMARY KEY (res, t)
) WITHOUT ROWID;

-- One row per collector feed: when it last ran, last worked, and is next due.
CREATE TABLE IF NOT EXISTS az_feed (
  feed        TEXT PRIMARY KEY,  -- a FeedId (shared/api.ts), or 'housekeeping'
  last_try_at TEXT,
  last_ok_at  TEXT,
  status      TEXT NOT NULL,     -- ok | error | not_configured | skipped | idle
  error       TEXT,              -- the last error in plain words; never a URL with a signature
  next_due_at TEXT
) WITHOUT ROWID;

-- The latest answer of the feeds that keep one document: 'health', 'metricDefs', 'bootlog'.
CREATE TABLE IF NOT EXISTS az_latest (
  key        TEXT PRIMARY KEY,
  json       TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

-- The Activity Log for the resource group, one row per operation (grouped by correlation id).
CREATE TABLE IF NOT EXISTS az_activity (
  id             TEXT PRIMARY KEY,  -- Azure's eventDataId of the row kept
  at             TEXT NOT NULL,
  correlation_id TEXT,
  operation      TEXT NOT NULL,     -- operationName, as Azure gives it
  status         TEXT NOT NULL,     -- the final status: Succeeded, Failed, or Started/Accepted while still running
  caller         TEXT,
  caller_kind    TEXT NOT NULL,     -- wgadmin | person | azure
  resource_type  TEXT NOT NULL,     -- plain name: Virtual machine, Network security group, ... Other
  resource_name  TEXT,
  category       TEXT,              -- Administrative, ResourceHealth, ...
  level          TEXT
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS az_activity_at ON az_activity (at);

-- Azure Service Health events that touch VMs or networking.
CREATE TABLE IF NOT EXISTS az_service_events (
  tracking_id TEXT PRIMARY KEY,
  type        TEXT NOT NULL,     -- ServiceIssue | PlannedMaintenance
  status      TEXT NOT NULL,     -- Active | Resolved
  level       TEXT,
  title       TEXT NOT NULL,
  summary     TEXT,
  services    TEXT NOT NULL,     -- JSON array of service names
  regions     TEXT NOT NULL,     -- JSON array of region display names ("UK South")
  starts_at   TEXT,
  ends_at     TEXT,
  updated_at  TEXT NOT NULL
) WITHOUT ROWID;

-- Region capacity and quota, the latest per region (JSON: sizes offered and restricted, vCPU usage).
CREATE TABLE IF NOT EXISTS az_capacity (
  region     TEXT PRIMARY KEY,
  json       TEXT NOT NULL,
  fetched_at TEXT NOT NULL
) WITHOUT ROWID;

-- Azure retail list prices in GBP, the latest per region and item.
CREATE TABLE IF NOT EXISTS az_prices (
  region     TEXT NOT NULL,
  item       TEXT NOT NULL,     -- a VM size (Standard_B1s), 'disk:E4', 'disk:S4' or 'ip:v4'
  gbp        REAL NOT NULL,     -- per unit
  unit       TEXT NOT NULL,     -- '1 Hour' or '1/Month', as Azure gives it
  meter      TEXT NOT NULL,     -- Azure's meterName
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (region, item)
) WITHOUT ROWID;
