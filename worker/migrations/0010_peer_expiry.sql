-- 0010_peer_expiry.sql
--
-- Plain English: two dates on each client.
--   peers.expires_at         when a guest client stops working ("1 day", "1 week"...).
--                            Empty = never. Once it passes, the client is left off
--                            the VM and the watchman switches it off with a note in
--                            Activity.
--   peers.last_handshake_at  the last time the client actually connected, kept
--                            across tear-downs (the VM's own figure is lost with
--                            it). Only written when it moves by more than an hour,
--                            so heartbeats do not rewrite it every 30 seconds.
--                            Drives the "no handshake in 30 days" marker.

ALTER TABLE peers ADD COLUMN expires_at TEXT;
ALTER TABLE peers ADD COLUMN last_handshake_at TEXT;
