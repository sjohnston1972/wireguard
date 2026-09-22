-- 0003_run_ssh_password.sql
--
-- Plain English: the per-deploy SSH password for azureuser, so the dashboard
-- can show it in the secret panel. It only works from the SSH allow-list and
-- dies with the VM.

ALTER TABLE runs ADD COLUMN ssh_password TEXT;
