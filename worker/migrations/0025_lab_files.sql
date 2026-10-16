-- 0025_lab_files.sql
--
-- Plain English: a lab run's files (AWS labs ruling A13, plan ruling P2):
-- lab 31's Client VPN profile, client certificate and key, sent by the
-- workflow beside its result, handed out only by GET /labs/:id/secret while
-- the session runs, and cleared with the admin password when it ends.
ALTER TABLE lab_runs ADD COLUMN files_json TEXT;
