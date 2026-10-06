Hybrid name resolution in both directions with Azure DNS Private Resolver. An Azure VNet and an "on-prem" VNet with its
own DNS server (dnsmasq on a small VM) each resolve the other's private names: Azure sends the on-prem domain out through
the resolver's **outbound endpoint** and a **forwarding ruleset**, and the on-prem server forwards the Azure private zone
to the resolver's **inbound endpoint**. From the AZ-700 outline (Design and implement core networking infrastructure):
design and implement Azure DNS Private Resolver, private DNS zones, name resolution inside a virtual network and DNS
settings for a virtual network, and plan subnet delegation.

## What it deploys

- `vnet-hub` ("Azure", the first /20 of the session's address slot) with `snet-app` (/24) and two /28 subnets delegated to `Microsoft.Network/dnsResolvers`, `snet-in` and `snet-out`
- `vnet-onprem` (the second /20), standing in for an on-premises site: its **DNS servers** setting is `vm-dns`. The two VNets are peered both ways, in place of the VPN or ExpressRoute a real site would use
- `dnspr-hub`, a DNS Private Resolver in the hub, with the inbound endpoint `in-hub` (a dynamic address in `snet-in`) and the outbound endpoint `out-hub` (in `snet-out`)
- `frs-onprem`, a forwarding ruleset on `out-hub` with one rule, `onprem.lab32.internal.` to `vm-dns` on port 53, linked to `vnet-hub`
- `azure.lab32.internal`, a private DNS zone linked to `vnet-hub` with **auto-registration** on, so `vm-app` registers its own name
- `vm-app` in `snet-app`, and `vm-dns` in `vnet-onprem` at a fixed address: Standard_B1s Ubuntu 24.04 VMs with no public IP. `vm-dns` runs dnsmasq, which answers `onprem.lab32.internal` itself (`fileserver` and `dns`, both its own address) and forwards `azure.lab32.internal` to `in-hub`. Its own network interface asks Azure DNS, not itself

While the lab is peered, ssh to `vm-app` from a tunnel client and go on to `vm-dns` from there (peering is not transitive). The VM user is `azureuser`; its password is behind **Show**. While peered, the gateway's VNet is linked to `azure.lab32.internal` too, so a tunnel client can resolve `vm-app.azure.lab32.internal`.

```text
rg-lab-<id>
  vnet-hub "Azure" (slot /20 #0)          <-- peering (optional) <--> gateway VNet <--> tunnel <--> you
    snet-app   vm-app  (registers in azure.lab32.internal)
    snet-in    in-hub  (inbound endpoint)  <------------------------------+
    snet-out   out-hub (outbound endpoint)                                |
                 frs-onprem: onprem.lab32.internal. -> vm-dns:53 --+      |
          ^ peering ("the VPN") v                                  |      |
  vnet-onprem "on-prem" (/20 #1), DNS server: vm-dns               |      |
    snet-onprem  vm-dns (dnsmasq)  <-------------------------------+      |
                   azure.lab32.internal -> in-hub ------------------------+
```

## Things to try

- From `vm-app`, run `dig fileserver.onprem.lab32.internal`: Azure DNS matches the ruleset's domain and the outbound endpoint asks `vm-dns`. On `vm-dns`, `journalctl -u dnsmasq` shows the query arriving from an address in `snet-out`.
- From `vm-dns`, run `dig vm-app.azure.lab32.internal` and get nothing (its NIC asks Azure DNS, and `vnet-onprem` is not linked to the zone), then `dig @<vm-dns's own address> vm-app.azure.lab32.internal`: dnsmasq forwards to the inbound endpoint, which answers from the zone.
- Add a second rule to `frs-onprem` (say `contoso.internal.` to `vm-dns`, then add a `host-record` for it in `/etc/dnsmasq.d/lab32.conf`), and link the ruleset to a VNet you create by hand: rulesets are shared by every VNet linked to them.
- While the lab is peered, resolve `vm-app.azure.lab32.internal` from your own machine over the tunnel, and explain why `fileserver.onprem.lab32.internal` does not resolve there.
- Compare this with the older pattern of DNS forwarder VMs in the hub: what the resolver's endpoints replace, what they cost, and what would go wrong if a ruleset linked to `vnet-hub` forwarded a domain to `in-hub`.

## Learn more

- [What is Azure DNS Private Resolver?](https://learn.microsoft.com/azure/dns/dns-private-resolver-overview)
- [Azure DNS Private Resolver endpoints and rulesets](https://learn.microsoft.com/azure/dns/private-resolver-endpoints-rulesets)
- [Resolve Azure and on-premises domains](https://learn.microsoft.com/azure/dns/private-resolver-hybrid-dns)
- [What is an Azure Private DNS zone?](https://learn.microsoft.com/azure/dns/private-dns-overview)
- [What is the auto registration feature in Azure DNS private zones?](https://learn.microsoft.com/azure/dns/private-dns-autoregistration)
- [Name resolution for resources in Azure virtual networks](https://learn.microsoft.com/azure/virtual-network/virtual-networks-name-resolution-for-vms-and-role-instances)

Anything you build by hand inside `rg-lab-az700-32-dns-resolver` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az700-32-dns-resolver-`.
