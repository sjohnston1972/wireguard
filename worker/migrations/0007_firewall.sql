-- 0007_firewall.sql
--
-- Plain English: the firewall's rule table. Each rule says: traffic from here
-- to there, of this kind, is allowed or denied. Top to bottom, first match
-- wins; anything that matches no rule gets the default (deny, unless changed
-- in Settings). Ends are "any", a zone (clients, home, azure, workloads,
-- internet), one client (by id) or a CIDR.
--
-- The starter rules below keep today's behaviour: clients may reach the
-- internet, Azure, the home LAN and each other; workloads may reach the
-- internet for updates. Everything else, such as Azure to the home LAN, is
-- denied until you add a rule for it.

CREATE TABLE IF NOT EXISTS fw_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
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

INSERT INTO fw_rules (position, enabled, name, src_kind, src_value, dst_kind, dst_value, proto, ports, action, log, created_at) VALUES
  (10, 1, 'Clients to the internet (full tunnel)', 'zone', 'clients', 'zone', 'internet', 'any', '', 'allow', 0, '2026-09-24T00:00:00Z'),
  (20, 1, 'Clients to the Azure VNet', 'zone', 'clients', 'zone', 'azure', 'any', '', 'allow', 0, '2026-09-24T00:00:00Z'),
  (30, 1, 'Clients to the home LAN', 'zone', 'clients', 'zone', 'home', 'any', '', 'allow', 0, '2026-09-24T00:00:00Z'),
  (40, 1, 'Clients to each other', 'zone', 'clients', 'zone', 'clients', 'any', '', 'allow', 0, '2026-09-24T00:00:00Z'),
  (50, 1, 'Workloads to the internet (updates)', 'zone', 'workloads', 'zone', 'internet', 'any', '', 'allow', 0, '2026-09-24T00:00:00Z');
