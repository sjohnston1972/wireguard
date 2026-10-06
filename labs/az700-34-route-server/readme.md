Dynamic routing between a network virtual appliance and Azure with **Azure Route Server**. A small Linux router in the
hub runs FRR and announces a prefix over BGP; Route Server programs it into the hub and, through the peering's remote
gateway, into a spoke, with no route table anywhere. From the AZ-700 outline (Design and implement core networking
infrastructure): design and implement Azure Route Server, network virtual appliances, gateway transit and virtual network
peering. The Route Server takes about 25 minutes to deploy, so allow half an hour before the lab is ready.

## What it deploys

- `vnet-hub` (the first /20 of the session's address slot) with `RouteServerSubnet` (/26) and `snet-nva` (/24)
- `rs-hub`, a Standard **Route Server** in `RouteServerSubnet`, with `pip-rs`, a Standard zone-redundant public IP that Route Server requires (it manages the service; nothing reaches the VMs through it). Branch-to-branch is off
- `vm-nva`, a Standard_B1s Ubuntu 24.04 VM at a fixed address in `snet-nva`, with **IP forwarding** on its network interface and in the kernel. Cloud-init installs **FRR** (Ubuntu's 8.4.4) and peers it, as ASN **65010**, with **both** Route Server instances (ASN 65515) over eBGP multihop. It announces the first /24 of the slot's last /20, held by a dummy interface `lab0`, so that prefix is in no VNet
- `bgp-nva`, Route Server's BGP connection to `vm-nva` (peer ASN 65010)
- `vnet-spoke` (the second /20) with `vm-app` (serves its name on port 80), peered with the hub: the hub side **allows gateway transit**, the spoke side **uses the remote gateway**, which here is Route Server
- No public IP on either VM, and no route table

While the lab is peered, ssh to `vm-nva` from a tunnel client and go on to `vm-app` from there (peering is not transitive). The VM user is `azureuser`; its password is behind **Show**. The serial console works too.

```text
rg-lab-<id>
  vnet-hub (slot /20 #0)            <-- peering (optional) <--> gateway VNet <--> tunnel <--> you
    RouteServerSubnet /26   rs-hub (ASN 65515, two instances) [pip-rs]
                               ^  eBGP multihop to both instances
    snet-nva /24            vm-nva (FRR, ASN 65010, IP forwarding)
                               lab0: announces slot /20 #3's first /24
       |  peering: hub allows gateway transit, spoke uses the remote gateway
  vnet-spoke (/20 #1)
    snet-app /24            vm-app :80
                               effective route: announced /24 -> vm-nva
```

## Things to try

- On `vm-nva`, run `sudo vtysh -c 'show ip bgp summary'` (two neighbours, Established) and `sudo vtysh -c 'show ip bgp'`: the hub's and the spoke's /20s arrive from Route Server, and the /24 is your own.
- In Cloud Shell, run `az network routeserver peering list-learned-routes -g rg-lab-<id> --routeserver rs-hub -n bgp-nva`: the /24 as each Route Server instance learned it, with AS path 65010.
- Open `vm-app`'s network interface, **Effective routes**: the announced /24 with next hop type **VirtualNetworkGateway** and `vm-nva`'s address. From `vm-app`, `ping` the first address of that /24 (on the dashboard as `advertised`): `vm-nva` answers from `lab0`.
- Withdraw the route (`sudo vtysh`, then `configure terminal`, `router bgp 65010`, `address-family ipv4 unicast`, `no network <prefix>`) and watch it leave `vm-app`'s effective routes. Put it back.
- Make the route less preferred with an AS-path prepend: a route map that runs `set as-path prepend 65010 65010` on the neighbours' outbound updates. Read in the Route Server FAQ how prepending chooses between two NVAs that announce the same prefix.
- Read what **branch-to-branch** would do if this hub also had a VPN or ExpressRoute gateway, and why it is off here.

## Learn more

- [What is Azure Route Server?](https://learn.microsoft.com/azure/route-server/overview)
- [Azure Route Server frequently asked questions](https://learn.microsoft.com/azure/route-server/route-server-faq)
- [Configure BGP peering between Azure Route Server and a network virtual appliance](https://learn.microsoft.com/azure/route-server/peer-route-server-with-virtual-appliance)
- [Virtual network peering](https://learn.microsoft.com/azure/virtual-network/virtual-network-peering-overview)
- [Virtual network traffic routing](https://learn.microsoft.com/azure/virtual-network/virtual-networks-udr-overview)

Anything you build by hand inside `rg-lab-az700-34-route-server` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az700-34-route-server-`.
