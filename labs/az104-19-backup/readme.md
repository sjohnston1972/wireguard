A Recovery Services vault protecting a small Linux VM under a daily backup policy. Practise running a backup on demand, recovering a single file, restoring a whole VM and stopping protection, and see what the vault's security settings would do to a tear-down. From the AZ-104 outline: create a Recovery Services vault, create and configure a backup policy, and perform backup and restore operations by using Azure Backup.

## What it deploys

- A Recovery Services vault, `rsv-lab` (Standard, locally redundant), with **soft delete on** (Azure requires it on a new vault) and **immutability Disabled**. Tear-down turns soft delete off first, so it can delete the backup data at once and then the vault
- A daily Enhanced backup policy, `policy-daily-7d`: one backup a day at 23:00 UTC, 7 daily recovery points, and instant-restore snapshots kept for one day in a resource group Azure makes for them, `rg-lab-az104-19-backup-irp1`
- A Standard_B1s Ubuntu 24.04 VM, `vm-backup`, with no public IP and boot diagnostics on (so the portal's serial console works), protected by that policy
- An empty storage account ending `stage`, for restores to stage through
- A small VNet, `vnet-lab` (the first /20 of the session's address slot), with `snet-vms`

Deploying turns protection on but runs no backup: the first one runs when you press **Backup now**, or at 23:00 UTC. Its snapshot is ready for a restore within minutes; the copy into the vault can take an hour or more. The VM user is `azureuser`; its password is behind **Show**. Deploy with **Peer to gateway** to reach the VM from a tunnel client, or use the portal's serial console or Run command.

Never lock the vault's immutability, and never make soft delete always-on: either one stops tear-down from deleting the backup data and the vault, which then go on costing money until the data expires. Restore only into `rg-lab-az104-19-backup`: anything restored elsewhere is not removed at tear-down.

```text
rg-lab-<id>
  vnet-lab (slot /20)
    snet-vms (/24)
      vm-backup (B1s, no public IP) <--protects-- rsv-lab (Standard, LRS)
                                                    policy-daily-7d (daily, 7 points)
  <prefix>stage (restore staging)                   soft delete on, immutability Disabled
rg-lab-<id>-irp1 (made by Azure: instant-restore snapshots, 1 day)
       peering (optional) <--> gateway VNet <--> WireGuard tunnel <--> you
```

## Things to try

- Write a file on the VM (`echo precious > ~/precious.txt`), then open `rsv-lab` → **Backup items** → **Azure Virtual Machine** → `vm-backup` and press **Backup now**. Follow it under **Backup jobs**: first "Take Snapshot", then "Transfer data to vault".
- Once the snapshot is done, delete `~/precious.txt` and get it back with **File Recovery**: download the script for that recovery point, run it on the VM with `sudo python3`, copy the file back from the mounted volume, then unmount the disks from the portal.
- Restore to a new VM: **Restore VM** → **Create new**, in `rg-lab-az104-19-backup`, on `vnet-lab`/`snet-vms`, staging through the account ending `stage`. Restore only into `rg-lab-az104-19-backup`; the new VM costs as much as `vm-backup` while it runs.
- Look inside `rg-lab-az104-19-backup-irp1` for the restore point collection the snapshot lives in, and at **Alerts** in the vault or Business Continuity Center: a failed backup job raises a built-in Azure Monitor alert.
- Change the policy's backup time or retention, then **Stop backup** on `vm-backup` with **Retain backup data** and see the item's state change. Then stop it again with **Delete backup data**: because soft delete is on, the item stays in **Backup items**, marked soft-deleted, for 14 days, and **Undelete** brings it back with its recovery points. Tear-down turns soft delete off, undeletes anything soft-deleted and deletes its data for good, so nothing is left behind or billed.
- Before you tear down, check **Backup jobs**: a Backup now still copying into the vault can hold the vault until it ends, so cancel it or let it finish.

## Learn more

- [What is the Azure Backup service?](https://learn.microsoft.com/azure/backup/backup-overview)
- [Recovery Services vaults overview](https://learn.microsoft.com/azure/backup/backup-azure-recovery-services-vault-overview)
- [An overview of Azure VM backup](https://learn.microsoft.com/azure/backup/backup-azure-vms-introduction)
- [Back up an Azure VM using Enhanced policy](https://learn.microsoft.com/azure/backup/backup-azure-vms-enhanced-policy)
- [Restore Azure VMs in the portal](https://learn.microsoft.com/azure/backup/backup-azure-arm-restore-vms)
- [Recover files from Azure VM backup](https://learn.microsoft.com/azure/backup/backup-azure-restore-files-from-vm)
- [Soft delete for Azure Backup](https://learn.microsoft.com/azure/backup/backup-azure-security-feature-cloud)
- [Immutable vault for Azure Backup](https://learn.microsoft.com/azure/backup/backup-azure-immutable-vault-concept)

Anything you build by hand inside `rg-lab-az104-19-backup` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az104-19-backup-`.
