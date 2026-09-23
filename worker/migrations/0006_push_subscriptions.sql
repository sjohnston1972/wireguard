-- 0006_push_subscriptions.sql
--
-- Plain English: the phones that turned on alerts in the wg-admin app. Each
-- row is where that phone's push service accepts messages for it, plus the
-- two keys its alerts are encrypted to. Deleting a row stops its alerts.

CREATE TABLE IF NOT EXISTS push_subs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  label       TEXT,              -- "Android phone", from the browser, to tell devices apart
  created_at  TEXT NOT NULL,
  last_ok     TEXT,
  last_error  TEXT
);
