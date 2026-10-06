-- 0021_ui_prefs_topology.sql
--
-- Plain English: lets ui_prefs also hold each person's saved arrangement of a
-- lab's diagram, one row per person per lab with page 'topology:<lab id>'
-- (lab topology spec §8.3, ruling 17). SQLite cannot change a CHECK in place,
-- so the table is rebuilt: a new table with the wider check, every existing
-- row copied across unchanged (version and updated_at included), the old one
-- dropped and the new one renamed. Same columns, same key, still WITHOUT
-- ROWID. The rows stay cosmetic: never in the backup export, the audit log or
-- the Activity change log; the dev seeder wipes them.
--
-- A topology page is 'topology:' and a lab id (az<exam>-<nn>-<slug>), at most
-- 60 characters in all; anything else is refused, as before.

CREATE TABLE ui_prefs_new (
  user       TEXT    NOT NULL,          -- Access identity email, lower case (c.get("user"))
  page       TEXT    NOT NULL CHECK (
               page IN ('overview','clients','firewall','activity','cost')
               OR (page GLOB 'topology:az[0-9][0-9][0-9]-[0-9][0-9]-*' AND length(page) <= 60)
             ),
  json       TEXT    NOT NULL,          -- widgets: normalised PagePrefs <= 8 KB; topology: TopologyLayout <= 16 KB
  version    INTEGER NOT NULL,          -- revision for optimistic concurrency: 1 on first save, +1 on every save
  updated_at TEXT    NOT NULL,          -- ISO, UTC
  PRIMARY KEY (user, page)
) WITHOUT ROWID;

INSERT INTO ui_prefs_new (user, page, json, version, updated_at)
  SELECT user, page, json, version, updated_at FROM ui_prefs;

DROP TABLE ui_prefs;

ALTER TABLE ui_prefs_new RENAME TO ui_prefs;
