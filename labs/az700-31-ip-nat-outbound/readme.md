Two VMs in subnets with **default outbound access** turned off, so neither can reach the internet unless you give it a way
out. One leaves through a NAT gateway, the other through a Standard public load balancer that has nothing but an
**outbound rule**, and each uses the addresses of its own public IP prefix. From the AZ-700 outline (Design and implement
core networking infrastructure): create a prefix for public IP addresses, choose when to use a public IP address prefix,
associate public IP addresses to resources, and implement a NAT gateway and explicit outbound connectivity.

## What it deploys

- One VNet, `vnet-hub` (the first /20 of the session's address slot), with two /24 subnets, `snet-nat` and `snet-lb`, both with **default outbound access** off, and `nsg-hub` on both with Azure's default rules only (nothing from the internet is allowed in)
- Two Standard, zone-redundant **public IP prefixes**, `pfx-nat` and `pfx-lb`, each a /31: two public addresses apiece, and no public IP resource anywhere
- `ng-hub`, a Standard **NAT gateway** (idle timeout 4 minutes) using `pfx-nat`'s addresses, on `snet-nat`
- `lb-out`, a Standard public load balancer whose only frontend, `fe-out`, takes its addresses from `pfx-lb`. Its only rule is the outbound rule `ob-all`: all protocols, 32,000 SNAT ports for each VM in the backend pool `be-out`, idle timeout 4 minutes, TCP reset on. No load-balancing rule, no probe, no inbound NAT rule: nothing reaches a VM through it
- `vm-nat` in `snet-nat` and `vm-lb` in `snet-lb` (in `be-out`): Standard_B1s Ubuntu 24.04 VMs with no public IP

While the lab is peered, ssh to either VM from a tunnel client. The VM user is `azureuser`; its password is behind **Show**. The serial console works too. The two prefixes are listed beside the VMs on the dashboard.

```text
rg-lab-<id>
  vnet-hub (slot /20 #0)        <-- peering (optional) <--> gateway VNet <--> tunnel <--> you
    snet-nat (default outbound off)  --> ng-hub (NAT gateway) --> pfx-nat /31 --> internet
      vm-nat
    snet-lb  (default outbound off)
      vm-lb  --> be-out --> lb-out: outbound rule ob-all --> fe-out = pfx-lb /31 --> internet
                            (no load-balancing rule, no inbound NAT)
```

## Things to try

- From each VM run `curl -s https://ifconfig.me` a few times and match the address to its prefix: `vm-nat` always shows one of `pfx-nat`'s two addresses, `vm-lb` one of `pfx-lb`'s.
- Associate `ng-hub` with `snet-lb` too and repeat the curl from `vm-lb`: the NAT gateway wins over the load balancer's outbound rule for that subnet. Remove the association after.
- Look at `lb-out`'s **Allocated SNAT ports** and **SNAT connection count** metrics while running `for i in $(seq 200); do curl -s -o /dev/null https://www.microsoft.com; done` from `vm-lb`. Then change `ob-all`'s allocated ports (two addresses give 128,000 ports to share: 32,000 each serves four VMs, 64,000 only two) and run it again.
- Make a public IP from a prefix by hand: create a /30 Standard prefix in the lab's group, then a public IP address with **Public IP prefix** as its source, and see that its address is one of the prefix's. Delete both after.
- Read why default outbound access is going away for new VNets, then turn it back on for `snet-nat` and repeat the curl: with the NAT gateway there nothing changes, because an explicit way out always wins over the default one.

## Not built here

**Custom IP prefixes (BYOIP).** You can bring a public range your organisation owns into Azure as a custom IP prefix, then cut public IP prefixes from it exactly as this lab does from Azure's own. It needs a registered range, a signed authorisation message with the regional internet registry and days of validation, so it is described here only, and the lab scope check refuses `azurerm_custom_ip_prefix`. See [Custom IP address prefix (BYOIP)](https://learn.microsoft.com/azure/virtual-network/ip-services/custom-ip-address-prefix).

## Learn more

- [Public IP address prefix](https://learn.microsoft.com/azure/virtual-network/ip-services/public-ip-address-prefix)
- [What is Azure NAT Gateway?](https://learn.microsoft.com/azure/nat-gateway/nat-overview)
- [Outbound rules for Azure Load Balancer](https://learn.microsoft.com/azure/load-balancer/outbound-rules)
- [Source Network Address Translation (SNAT) for outbound connections](https://learn.microsoft.com/azure/load-balancer/load-balancer-outbound-connections)
- [Default outbound access in Azure](https://learn.microsoft.com/azure/virtual-network/ip-services/default-outbound-access)
- [Custom IP address prefix (BYOIP)](https://learn.microsoft.com/azure/virtual-network/ip-services/custom-ip-address-prefix)

Anything you build by hand inside `rg-lab-az700-31-ip-nat-outbound` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az700-31-ip-nat-outbound-`.
