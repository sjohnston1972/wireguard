-- 0008_forwards_captures.sql
--
-- Plain English: two more firewall-appliance features.
--   fw_forwards  published ports: a public TCP/UDP port on the VM forwarded
--                to a server behind it (destination NAT), optionally only
--                from one source network
--   captures     packet captures taken on the VM, stored in R2 for download

CREATE TABLE IF NOT EXISTS fw_forwards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  name        TEXT NOT NULL,
  proto       TEXT NOT NULL CHECK (proto IN ('tcp', 'udp')),
  public_port INTEGER NOT NULL,
  target_ip   TEXT NOT NULL,
  target_port INTEGER NOT NULL,
  allow_from  TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  UNIQUE (proto, public_port)
);

CREATE TABLE IF NOT EXISTS captures (
  id           TEXT PRIMARY KEY,
  requested_at TEXT NOT NULL,
  requested_by TEXT,
  iface        TEXT NOT NULL,
  filter       TEXT NOT NULL DEFAULT '',
  seconds      INTEGER NOT NULL,
  status       TEXT NOT NULL,     -- waiting | running | done | failed
  bytes        INTEGER,
  finished_at  TEXT,
  error        TEXT
);
