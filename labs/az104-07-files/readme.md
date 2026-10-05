## What it deploys

- A storage account ending `files` (StorageV2, standard, LRS) with a 5 GiB SMB share, `labshare`, and soft delete for shares (7 days)
- A storage firewall that denies everything except the subnet `snet-vms`, which reaches the account through a **Microsoft.Storage** service endpoint
- A small VNet, `vnet-lab` (the first /20 of the session's address slot), with `snet-vms`
- A Standard_B1s Ubuntu 24.04 VM, `vm-files`, with no public IP and boot diagnostics on (so the portal's serial console works)
- At first boot, cloud-init installs `cifs-utils`, mounts the share at `/mnt/labshare` (also in `/etc/fstab`) and writes `hello-from-vm.txt` to it. The account key sits only in a root-only credentials file, never in a command or a log.

The VM user is `azureuser`; its password is behind **Show**. Deploy with **Peer to gateway** to reach the VM from a tunnel client, or use the portal's serial console or Run command.

```text
rg-lab-<id>
  vnet-lab (slot /20)
    snet-vms (/24)  service endpoint: Microsoft.Storage
      vm-files (B1s, no public IP) --SMB 3.1.1, port 445--> <prefix>files
                                                              firewall: deny, allow snet-vms
                                                              share labshare (5 GiB)
       peering (optional) <--> gateway VNet <--> WireGuard tunnel <--> you
```

## Things to try

- Connect to `vm-files` (the `ssh` Connect line while peered, or the serial console) and run `df -h /mnt/labshare`, `mount -t cifs` and `cat /mnt/labshare/hello-from-vm.txt`. Note the SMB version and that the password comes from a credentials file.
- Open `labshare` in the portal: browsing is refused because the firewall admits only `snet-vms`. Add your client IP under the account's **Networking**, browse again and find the file the VM wrote, then remove your IP.
- Remove `snet-vms` from the storage firewall and watch `ls /mnt/labshare` on the VM start failing, then add it back. While you are there, open the VM's network interface and look at **Effective routes**: the storage prefixes go to the service endpoint, not the internet.
- Take a snapshot of `labshare`, delete `hello-from-vm.txt` on the VM, and restore it from the snapshot in the portal.
- Delete the whole share, turn on **Show deleted shares** and undelete it. Run `sudo mount -a` on the VM if the mount has gone stale.
- Raise the share's quota, and change its tier from Transaction optimized to Hot or Cool, then see that the VM's mount carries on.

## Learn more

- [What is Azure Files?](https://learn.microsoft.com/azure/storage/files/storage-files-introduction)
- [Plan for an Azure Files deployment](https://learn.microsoft.com/azure/storage/files/storage-files-planning)
- [Mount an SMB Azure file share on Linux](https://learn.microsoft.com/azure/storage/files/storage-how-to-use-files-linux)
- [Azure Files networking considerations](https://learn.microsoft.com/azure/storage/files/storage-files-networking-overview)
- [Virtual network service endpoints](https://learn.microsoft.com/azure/virtual-network/virtual-network-service-endpoints-overview)
- [Share snapshots for Azure Files](https://learn.microsoft.com/azure/storage/files/storage-snapshots-files)
- [Soft delete for Azure file shares](https://learn.microsoft.com/azure/storage/files/storage-files-prevent-file-share-deletion)

Anything you build by hand inside `rg-lab-az104-07-files` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az104-07-files-`.
