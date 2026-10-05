Disaster recovery for a VM across two Azure regions with Azure Site Recovery: a small Linux VM in uksouth replicates continuously to ukwest, so you can test a failover without touching the original, read the recovery points it keeps, and fail over for real. From the AZ-305 outline: design solutions for backup and disaster recovery (recommend a recovery solution for Azure workloads that meets recovery objectives, and a backup and recovery solution for compute) and design for high availability (recommend a high availability solution for compute).

Deploy this lab in uksouth: it replicates to ukwest, uksouth's Azure pair. Besides `rg-lab-az305-26-site-recovery` it makes a second resource group in ukwest, `rg-lab-az305-26-site-recovery-secondary`, which holds the Recovery Services vault, both target networks and everything Site Recovery makes: the replica disk, and any failover or test failover VM with its NIC and disk.

## What it deploys

- `vm-app`, a Standard_B1s Ubuntu 22.04 VM in `vnet-source` (the first /20 of the session's address slot), with no public IP and boot diagnostics on. It serves `vm-app in <region>` on port 80, asking the instance metadata service which region it is in each time it starts, so a failed-over copy answers `vm-app in ukwest`
- An empty storage account ending `cache` (Standard, LRS, uksouth), where Site Recovery stages the disk's writes before they cross regions
- In `rg-lab-az305-26-site-recovery-secondary`: `rsv-lab`, a Recovery Services vault (Standard, locally redundant) with **soft delete on** (Azure requires it on a new vault; tear-down turns it off) and **immutability Disabled**; `vnet-target` (the second /20), where a failover puts the VM; and `vnet-test` (the third /20), an isolated network for test failovers
- Site Recovery inside `rsv-lab`: a fabric and a protection container for each region, `policy-6h` (crash-consistent recovery points kept 6 hours, no app-consistent snapshots), the container mapping (agent auto-update off, so no automation account), the network mapping from `vnet-source` to `vnet-target`, and replication of `vm-app` to a Standard HDD replica disk

Deploying takes about 40 minutes: Terraform waits for the initial replication to finish. The VM user is `azureuser`; its password is behind **Show**. Deploy with **Peer to gateway** to reach `vm-app` from a tunnel client. Only `vnet-source` is peered: after a failover the VM is in ukwest, so reach it through the portal's serial console (turn on boot diagnostics, managed, on the failed-over VM first if they are off) or Run command.

Never re-protect the VM into another resource group, and never fail over into one: everything Site Recovery makes must stay in `rg-lab-az305-26-site-recovery` or `rg-lab-az305-26-site-recovery-secondary`, or tear-down cannot remove it. Site Recovery charges nothing for a protected VM's first 31 days, and every session protects a new one, so a session usually pays only for the VM, the disks and the initial copy across regions.

```text
rg-lab-<id> (uksouth)                        rg-lab-<id>-secondary (ukwest)
  vnet-source (slot /20 0)                     rsv-lab (Standard, LRS, soft delete on)
    snet-vms (/24)                               fabric + container per region, policy-6h
      vm-app (B1s, Ubuntu 22.04) ==replicates==> vm-app replica disk (S4)
  <prefix>cache (staging)                      vnet-target (slot /20 1) <-- failover
                                               vnet-test   (slot /20 2) <-- test failover
vnet-source <--peering (optional)--> gateway VNet <--> WireGuard tunnel <--> you
```

## Things to try

- Run a disaster recovery drill: open `rsv-lab` → **Replicated items** → `vm-app`, wait for replication health **Healthy**, then **Test failover** to the latest processed recovery point into `vnet-test`. Watch `vm-app-test` appear in `rg-lab-az305-26-site-recovery-secondary`, run `curl -s localhost` on it with Run command (it answers `vm-app in ukwest`), then **Clean up test failover**. The test VM costs as much as `vm-app` while it runs.
- Read the recovery objectives: on `vm-app`'s overview, the RPO and the latest crash-consistent recovery point; under **Recovery points**, the 6 hours `policy-6h` keeps. Write a file on `vm-app` and work out from the RPO how soon a failover would bring it along.
- Build a recovery plan by hand: **Recovery Plans (Site Recovery)** → **Recovery plan**, from uksouth to ukwest, with `vm-app`, and add a manual action to it. Run a test failover of the plan and clean it up. Delete the plan before you tear down.
- Fail over for real: **Failover** `vm-app` to the latest recovery point, check the copy in ukwest with Run command, then **Commit**. Do not **Re-protect**: tear the lab down instead. The original VM stays in uksouth, and the failed-over one is deleted with `rg-lab-az305-26-site-recovery-secondary`.
- Sketch the design choices: Site Recovery's RPO of minutes against Azure Backup's daily points (lab 19), availability zones (a datacenter, not a region), and what a real workload would also need in the target region: DNS, a load balancer, the database's own geo-replication.

## Learn more

- [About Site Recovery](https://learn.microsoft.com/azure/site-recovery/site-recovery-overview)
- [Azure to Azure disaster recovery architecture](https://learn.microsoft.com/azure/site-recovery/azure-to-azure-architecture)
- [Support matrix for Azure VM disaster recovery between Azure regions](https://learn.microsoft.com/azure/site-recovery/azure-to-azure-support-matrix)
- [Run a disaster recovery drill for Azure VMs](https://learn.microsoft.com/azure/site-recovery/azure-to-azure-tutorial-dr-drill)
- [Fail over and reprotect Azure VMs between regions](https://learn.microsoft.com/azure/site-recovery/azure-to-azure-tutorial-failover-failback)
- [About recovery plans](https://learn.microsoft.com/azure/site-recovery/recovery-plan-overview)
- [Networking in Azure VM disaster recovery](https://learn.microsoft.com/azure/site-recovery/azure-to-azure-about-networking)
- [Azure cross-region replication and paired regions](https://learn.microsoft.com/azure/reliability/cross-region-replication-azure)

Anything you build by hand inside `rg-lab-az305-26-site-recovery` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az305-26-site-recovery-`.
