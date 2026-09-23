-- 0004_peer_tunnel_dns.sql
--
-- Plain English: a per-client switch. When on, the client's config points its
-- DNS at the resolver on the VM loopback (10.13.255.1): ad-blocking and names
-- like laptop.wg. Full-tunnel clients always use it; for split-tunnel ones it
-- is a choice, because a client left connected while the VM is destroyed
-- would have no DNS at all.

ALTER TABLE peers ADD COLUMN tunnel_dns INTEGER NOT NULL DEFAULT 0;
