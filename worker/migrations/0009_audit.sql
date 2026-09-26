-- 0009_audit.sql
--
-- Plain English: the change log. One row each time someone changes the
-- configuration from the dashboard (a client added, a firewall rule moved, a
-- setting saved...): when, who, what kind of change, what it was changed on,
-- and the before and after as JSON. Secrets (keys, passwords, tokens) are
-- stripped out before a row is written (db.ts audit()). The watchman trims it
-- to the newest 1000 rows and the last 180 days.

CREATE TABLE IF NOT EXISTS audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  user        TEXT NOT NULL,
  action      TEXT NOT NULL,     -- e.g. client.add, firewall.rule.move, settings.save
  target      TEXT NOT NULL DEFAULT '',
  before_json TEXT,
  after_json  TEXT
);

CREATE INDEX IF NOT EXISTS audit_at ON audit (at);
