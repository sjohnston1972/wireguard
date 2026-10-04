-- 0018_ui_prefs.sql
--
-- Plain English: each signed-in person's widget preferences (which widgets
-- are hidden, their order in a row, and each widget's settings), one row per
-- person per page. Cosmetic only: never in the backup export, the audit log
-- or the Activity change log; the dev seeder wipes them.
--
-- `version` is the revision a save must name to land (optimistic
-- concurrency: 1 on the first save, +1 on every save). A reset writes {} and
-- keeps the row, so the version only ever rises and a stale tab can never
-- match a recreated row. Spec: docs/superpowers/specs/2026-10-03-widgets-design.md, 6.1.

CREATE TABLE IF NOT EXISTS ui_prefs (
  user       TEXT    NOT NULL,          -- Access identity email, lower case (c.get("user"))
  page       TEXT    NOT NULL CHECK (page IN ('overview','clients','firewall','activity','cost')),
  json       TEXT    NOT NULL,          -- normalised PagePrefs, sparse (only values that differ from defaults), <= 8 KB
  version    INTEGER NOT NULL,          -- revision for optimistic concurrency: 1 on first save, +1 on every save
  updated_at TEXT    NOT NULL,          -- ISO, UTC
  PRIMARY KEY (user, page)
) WITHOUT ROWID;
