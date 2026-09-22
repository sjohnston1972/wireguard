-- 0002_peer_azure_vnet.sql
--
-- Plain English: a per-client switch. When on, the client's config also
-- routes the Azure VNet (10.50.0.0/16) through the tunnel, so the client can
-- reach workloads that live next to the VM in Azure.

ALTER TABLE peers ADD COLUMN azure_vnet INTEGER NOT NULL DEFAULT 0;
