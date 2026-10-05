Two small Linux VMs spread over availability zones, a data disk and a VM extension. Practise creating VMs, placing them in
zones, resizing them and managing their disks, and see what an extension does once a VM is running. From the AZ-104
outline: create a virtual machine, deploy virtual machines to availability zones and availability sets, manage virtual
machine sizes, and manage virtual machine disks.

## What it deploys

- A small VNet, `vnet-lab` (the first /20 of the session's address slot), with one subnet, `snet-vms`
- Two Standard_B1s Ubuntu 24.04 VMs with no public IP and boot diagnostics on (so the portal's serial console works): `vm-zone1` in availability zone 1 and `vm-zone2` in zone 2
- `disk-zone1-data`, a 4 GiB Standard SSD (E1) data disk in zone 1, attached to `vm-zone1` at LUN 0. It is blank: no partition and no file system yet
- A Custom Script extension, `serve-web`, on each VM. It writes the VM's name to `/srv/www/index.html` and starts a small systemd service that serves it on port 80 with python3, which Ubuntu already has: nothing is installed or downloaded

The VM user is `azureuser`; its password is behind **Show**. Deploy with **Peer to gateway** to reach the VMs from a tunnel client, or use the portal's serial console or Run command.

```text
rg-lab-<id>
  vnet-lab (slot /20)
    snet-vms (/24)
      zone 1: vm-zone1 (B1s, no public IP) + disk-zone1-data (E1, LUN 0)
      zone 2: vm-zone2 (B1s, no public IP)
      each VM: extension serve-web --> python3 http.server on port 80
       peering (optional) <--> gateway VNet <--> WireGuard tunnel <--> you
```

## Things to try

- Run `curl http://<address>` against each VM (the Connect lines while peered), or open the VM's **Extensions + applications** blade and read `serve-web`'s status and output. Then look at **Overview** for each VM's availability zone.
- On `vm-zone1`, find the data disk with `lsblk` (a 4 GiB disk with no partition), then partition, format and mount it: `sudo parted /dev/sdc --script mklabel gpt mkpart data ext4 0% 100%`, `sudo mkfs.ext4 /dev/sdc1`, `sudo mount /dev/sdc1 /mnt`. Check the device name in `lsblk` first.
- Take a snapshot of `disk-zone1-data` in the portal, then grow the disk to 8 GiB (detach it first, or stop the VM) and use `growpart` and `resize2fs` to use the space. Note that a disk can grow but never shrink.
- Resize `vm-zone2` to another B-series size: see which sizes the portal offers while it runs, and which need it stopped first. Resize it back afterwards so the session's cost estimate holds.
- Try to attach `disk-zone1-data` to `vm-zone2`: Azure refuses, because a zonal disk can only attach to a VM in the same zone. Then create an availability set by hand and a VM in it, and compare what a set and a zone each protect you from.

## Learn more

- [Virtual machines in Azure](https://learn.microsoft.com/azure/virtual-machines/overview)
- [Availability options for Azure Virtual Machines](https://learn.microsoft.com/azure/virtual-machines/availability)
- [Create virtual machines in an availability zone](https://learn.microsoft.com/azure/virtual-machines/create-portal-availability-zone)
- [Introduction to Azure managed disks](https://learn.microsoft.com/azure/virtual-machines/managed-disks-overview)
- [Expand virtual hard disks on a Linux VM](https://learn.microsoft.com/azure/virtual-machines/linux/expand-disks)
- [Custom Script extension for Linux](https://learn.microsoft.com/azure/virtual-machines/extensions/custom-script-linux)
- [Change the size of a virtual machine](https://learn.microsoft.com/azure/virtual-machines/sizes/resize-vm)

Anything you build by hand inside `rg-lab-az104-08-vms` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az104-08-vms-`.
