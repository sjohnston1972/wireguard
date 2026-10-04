## What it deploys

- A storage account with an SMB file share, reached through a subnet service endpoint
- A Standard_B1s Linux VM with no public IP that mounts the share at boot

```text
rg-lab-<id>
  vnet (slot /20) -- service endpoint -- storage (SMB share)
  vm (no public IP) mounts the share
```

## Things to try

- Peer the lab and SSH to the VM over the tunnel
- Write a file on the share from the VM and find it in the portal
- Take a share snapshot and restore a file from it

## Learn more

- [Azure Files](https://learn.microsoft.com/azure/storage/files/storage-files-introduction)

This readme is a stub; the lab's author (plan area L6) writes the full one.

Anything you build by hand inside `rg-lab-az104-07-files` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az104-07-files-`.
