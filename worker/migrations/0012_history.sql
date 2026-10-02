-- 0012_history.sql
--
-- Plain English: the dashboard's own history, like an SNMP poller's
-- database. Every heartbeat (about every 30 seconds while the VM runs) adds
-- to a one-minute sample for the VM and one per client. The watchman fills
-- in the minutes when no heartbeat came, folds samples older than 48 hours
-- into 5-minute summaries, and deletes anything older than 30 days.
-- Firewall drops are kept as one row per minute per distinct flow, with a
-- count. Runs keep their GitHub step list (steps_json).
--
-- The tables are WITHOUT ROWID: each row lives in its key index only, so a
-- write is one row, not two (D1 bills writes per row touched). A client that
-- is offline, moved no bytes and answered no ping gets no row that minute:
-- no row means idle and offline.

CREATE TABLE IF NOT EXISTS hist_vm (
  res          INTEGER NOT NULL,  -- seconds per row: 60 (raw) or 300 (5-minute summary)
  t            TEXT    NOT NULL,  -- start of the slot, "YYYY-MM-DDTHH:MM:SSZ" (UTC)
  expected     INTEGER NOT NULL,  -- minutes the VM was meant to be up in this slot
  received     INTEGER NOT NULL,  -- of those, minutes with at least one heartbeat
  load1        REAL,              -- 1-minute load average
  rx_rate      REAL,              -- bytes per second into the VM from clients
  tx_rate      REAL,              -- bytes per second from the VM to clients
  rx_rate_max  REAL,
  tx_rate_max  REAL,
  peers_online INTEGER,
  dns_up       INTEGER,           -- 1 up, 0 down, NULL not reported
  PRIMARY KEY (res, t)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS hist_client (
  res           INTEGER NOT NULL,
  t             TEXT    NOT NULL,
  peer_id       INTEGER NOT NULL,  -- peers.id: stays the same when a client is re-keyed
  online        INTEGER NOT NULL,  -- 1 if its last handshake was under 3 minutes old
  handshake_age INTEGER,           -- seconds since its last handshake; NULL = never
  latency_avg   REAL,              -- ms; NULL = no ping answered
  latency_max   REAL,
  rx            INTEGER NOT NULL,  -- bytes the VM received from it in this slot
  tx            INTEGER NOT NULL,  -- bytes the VM sent to it in this slot
  PRIMARY KEY (res, t, peer_id)     -- res and time first: the tidy-up reads by time range
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS hist_drops (
  t      TEXT    NOT NULL,           -- the minute, as above
  src    TEXT    NOT NULL,
  dst    TEXT    NOT NULL,
  proto  TEXT    NOT NULL,
  dport  INTEGER NOT NULL DEFAULT 0, -- 0 = no port (ICMP and the like)
  in_if  TEXT    NOT NULL DEFAULT '',
  out_if TEXT    NOT NULL DEFAULT '',
  n      INTEGER NOT NULL,           -- drops of this flow in this minute
  PRIMARY KEY (t, src, dst, proto, dport, in_if, out_if)
) WITHOUT ROWID;

ALTER TABLE runs ADD COLUMN steps_json TEXT;
