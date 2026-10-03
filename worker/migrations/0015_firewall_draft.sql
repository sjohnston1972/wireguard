-- 0015_firewall_draft.sql
--
-- Plain English: firewall rule edits from the new dashboard go into a draft
-- first; nothing reaches the VM until Apply. The draft is a full copy of the
-- rule table (fw_draft_rules), made by the first edit: each copied rule keeps
-- the live rule's id (live_id says which live rule it edits; null for a rule
-- added in the draft). fw_policy holds the live rule set's version (bumped by
-- every apply, restore, default change and old-page edit), the version the
-- draft began from, the draft's default action, and a one-time token Apply
-- uses so its whole batch happens only if the version still matched.
-- The live default action stays in settings (firewall_default).

CREATE TABLE IF NOT EXISTS fw_draft_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  live_id    INTEGER,
  position   INTEGER NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  name       TEXT NOT NULL,
  src_kind   TEXT NOT NULL CHECK (src_kind IN ('any', 'zone', 'client', 'cidr')),
  src_value  TEXT NOT NULL DEFAULT '',
  dst_kind   TEXT NOT NULL CHECK (dst_kind IN ('any', 'zone', 'client', 'cidr')),
  dst_value  TEXT NOT NULL DEFAULT '',
  proto      TEXT NOT NULL CHECK (proto IN ('any', 'tcp', 'udp', 'icmp')),
  ports      TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL CHECK (action IN ('allow', 'deny')),
  log        INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fw_policy (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  live_version  INTEGER NOT NULL,
  draft_base    INTEGER,
  draft_default TEXT CHECK (draft_default IN ('allow', 'deny')),
  apply_token   TEXT
);

INSERT OR IGNORE INTO fw_policy (id, live_version) VALUES (1, 1);
