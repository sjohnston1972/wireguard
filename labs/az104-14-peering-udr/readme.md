A hub VNet and two spoke VNets, each spoke peered with the hub, and a small Linux router in the hub that user-defined
routes (UDRs) send spoke-to-spoke traffic through. Practise peering VNets, see that peering is not transitive, and make
two spokes talk through a network virtual appliance with route tables. From the AZ-104 outline: create and configure
virtual network peering, configure user-defined network routes, and troubleshoot network connectivity.

## What it deploys

- Three VNets from the first three /20s of the session's address slot: `vnet-hub`, `vnet-spoke1` and `vnet-spoke2`, each with one /24 subnet
- Four peerings: hub to each spoke and back, all with **Allow forwarded traffic** on. The spokes are not peered with each other
- `vm-router` in the hub: a Standard_B1s Ubuntu 24.04 VM at a fixed address (the subnet's fourth host), with **IP forwarding** on its network interface and `net.ipv4.ip_forward` on in the kernel (cloud-init, nothing installed)
- `rt-spoke1` and `rt-spoke2`: each sends the other spoke's /20 to the router (next hop type **Virtual appliance**). Nothing routes `0.0.0.0/0`, so the VMs keep Azure's own way out
- `vm-spoke1` and `vm-spoke2`: Standard_B1s VMs with no public IP that serve their names on port 80 with python3's built-in web server

Peering is not transitive: the pipeline peers only the hub with the gateway, so the spokes are not reachable over the tunnel. While the lab is peered, ssh to `vm-router` from a tunnel client and go on to the spokes from there. The VM user is `azureuser`; its password is behind **Show**. The portal's serial console and Run command work on every VM too.

```text
rg-lab-<id>
  vnet-hub (slot /20 #0)
    snet-router  vm-router (IP forwarding)  <-- peering (optional) <--> gateway VNet <--> tunnel <--> you
       ^   peering, forwarded traffic   ^
       |                                |
  vnet-spoke1 (/20 #1)             vnet-spoke2 (/20 #2)
    snet-workload  rt-spoke1:        snet-workload  rt-spoke2:
      spoke2 /20 -> vm-router          spoke1 /20 -> vm-router
    vm-spoke1 :80                    vm-spoke2 :80
```

## Things to try

- From `vm-spoke1` run `curl http://<vm-spoke2 address>` and get `vm-spoke2` back. On `vm-router`, watch the same request pass through with `sudo tcpdump -ni eth0 port 80`.
- Open `vm-spoke1`'s network interface and look at **Effective routes**: the peering's route to the hub, Azure's defaults, and your user route to the other spoke with next hop type **VirtualAppliance**.
- In **Network Watcher**, run **Next hop** from `vm-spoke1` to `vm-spoke2`'s address, then to the router's, and compare the route each one uses.
- Turn off **IP forwarding** on `nic-vm-router` and repeat the curl: it fails even though the kernel still forwards. Turn it back on.
- Remove the route from `rt-spoke1` and try again: the spokes have no peering, so there is no way through. Put the route back.
- Peer the two spokes with each other by hand, then check effective routes: your user route still wins over the new peering route for the same prefix. Delete the new peerings after.

## Learn more

- [Virtual network peering](https://learn.microsoft.com/azure/virtual-network/virtual-network-peering-overview)
- [Virtual network traffic routing](https://learn.microsoft.com/azure/virtual-network/virtual-networks-udr-overview)
- [Create, change, or delete a route table](https://learn.microsoft.com/azure/virtual-network/manage-route-table)
- [Hub-spoke network topology in Azure](https://learn.microsoft.com/azure/architecture/networking/architecture/hub-spoke)
- [Next hop overview](https://learn.microsoft.com/azure/network-watcher/next-hop-overview)
- [Diagnose a virtual machine network routing problem](https://learn.microsoft.com/azure/virtual-network/diagnose-network-routing-problem)

Anything you build by hand inside `rg-lab-az104-14-peering-udr` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az104-14-peering-udr-`.
