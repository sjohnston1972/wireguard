-- 0011_key_rotation.sql
--
-- Plain English: a per-client "needs new config" flag for server key
-- rotation. When the server's public key in wrangler.toml changes, every
-- client's config still trusts the old key, so each one is flagged. The flag
-- clears on that client's first handshake with the VM after the change. The
-- key the dashboard last saw, and when it changed, live in the settings
-- table (key "server_key"), so no table is needed for that.

ALTER TABLE peers ADD COLUMN needs_config INTEGER NOT NULL DEFAULT 0;
