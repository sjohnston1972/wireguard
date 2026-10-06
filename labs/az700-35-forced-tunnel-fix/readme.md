A break-fix lab: a spoke VNet forces all its internet traffic through a network virtual appliance (NVA) in the hub,
and the appliance is not doing its job. Find out why with Network Watcher and the appliance itself, fix it, and prove
the fix. From the AZ-700 outline (Design and implement core networking infrastructure): design and implement
user-defined routes, forced tunnelling to a network virtual appliance, and diagnose and resolve routing issues. It
counts for AZ-305 too (Design infrastructure solutions: routing through an NVA).

## What it deploys

- `vnet-hub` (the first /20 of the session's address slot) with `snet-nva` (/24), and `vnet-spoke` (the second /20) with `snet-app` (/24). The two VNets are peered both ways with **Allow forwarded traffic** on
- `vm-nva` in `snet-nva` at a fixed address: the hub's appliance. Its subnet has default outbound access, so it can reach the internet itself
- `rt-spoke` on `snet-app` with one route, `default-via-nva`: `0.0.0.0/0` to `vm-nva`'s address, next hop type **Virtual appliance**. `snet-app` has **default outbound access off**, so that route is the spoke's only way out
- `vm-app` in `snet-app`. Both are Standard_B1s Ubuntu 24.04 VMs with no public IP

While the lab is peered, ssh to `vm-nva` from a tunnel client and go on to `vm-app` from there (peering is not transitive). The VM user is `azureuser`; its password is behind **Show**. The serial console works on both.

```text
rg-lab-<id>
  vnet-hub (slot /20 #0)            <-- peering (optional) <--> gateway VNet <--> tunnel <--> you
    snet-nva   vm-nva (the appliance)  --> internet (default outbound)
        ^ peering, forwarded traffic allowed
        |  0.0.0.0/0 -> vm-nva  (rt-spoke)
  vnet-spoke (/20 #1)
    snet-app (default outbound off)  vm-app
         curl -I https://www.microsoft.com   ...times out
```

## Symptom

From `vm-app`, `ping` and `ssh` to `vm-nva` work, but `curl -I https://www.microsoft.com` times out, and so does `sudo apt-get update`. Names still resolve (Azure DNS is not behind the route). Find out where the traffic stops, fix it, and show that the curl from `vm-app` now answers.

<details>
<summary>What was broken</summary>

The route is right: **Next hop** from `vm-app` to any internet address (try 13.107.42.14) shows next hop type **VirtualAppliance** and `vm-nva`'s address from `rt-spoke`, and `vm-app`'s **Effective routes** show `0.0.0.0/0` as a user route. The appliance at the end of it is what fails, three ways, and the curl only works once all three are fixed:

- **IP forwarding is off on `nic-vm-nva`.** Azure delivers a packet to a network interface only if it is addressed to that interface, unless IP forwarding is on. Fix: `nic-vm-nva`, **IP configurations**, **Enable IP forwarding**, Apply.
- **The kernel does not forward.** `/etc/sysctl.d/90-lab-nva.conf` sets `net.ipv4.ip_forward = 0`, so Linux drops packets that are not for itself (`sysctl net.ipv4.ip_forward` shows 0). Fix: `sudo sysctl -w net.ipv4.ip_forward=1`, and change the file to 1 so it survives a reboot.
- **No SNAT.** Forwarded packets still carry `vm-app`'s private address, and Azure only lets `vm-nva`'s outbound traffic out with `vm-nva`'s own address, so replies could never come back. Fix: translate the spoke's addresses on the way out, `sudo iptables -t nat -A POSTROUTING -s <vnet-spoke's /20> -o eth0 -j MASQUERADE` (if the command is missing, `sudo apt-get install -y iptables` on `vm-nva` first).

Then run the curl again, and watch it pass with `sudo tcpdump -ni eth0 host <vm-app's address>` on `vm-nva`. Next hop and effective routes say the same as before: the route was never the problem, the appliance was.

</details>

## Things to try

- Run **Next hop** from `vm-app` to an internet address and to `vm-nva`'s address, and explain why the hub is reached over the peering route and not through the appliance (the longer prefix wins).
- Fix one fault at a time and repeat the curl after each, with `sudo tcpdump -ni eth0` running on `vm-nva`: see which fault stops packets arriving at all, and which lets them arrive but never leave.
- Open `vm-app`'s network interface, **Effective routes**, then remove `default-via-nva` from `rt-spoke`: with default outbound access off, `vm-app` now has no way out at all. Put the route back.
- Read how VPN gateways do forced tunnelling another way, with a **default site** or a `0.0.0.0/0` learned over BGP sending internet traffic to on-premises: lab 36 builds the gateways to try it on.

## Learn more

- [Virtual network traffic routing](https://learn.microsoft.com/azure/virtual-network/virtual-networks-udr-overview)
- [Create, change, or delete a route table](https://learn.microsoft.com/azure/virtual-network/manage-route-table)
- [Next hop overview](https://learn.microsoft.com/azure/network-watcher/next-hop-overview)
- [Diagnose a virtual machine network routing problem](https://learn.microsoft.com/azure/virtual-network/diagnose-network-routing-problem)
- [Deploy highly available NVAs](https://learn.microsoft.com/azure/architecture/networking/guide/network-virtual-appliance-high-availability)
- [Configure forced tunneling for site-to-site connections](https://learn.microsoft.com/azure/vpn-gateway/vpn-gateway-forced-tunneling-rm)

Anything you build by hand inside `rg-lab-az700-35-forced-tunnel-fix` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az700-35-forced-tunnel-fix-`.
