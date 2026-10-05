One virtual network split into a web subnet and an app subnet, each behind its own network security group (NSG), with
application security groups (ASGs) naming the two tiers. Practise reading NSG rules in priority order, writing a rule
between ASGs instead of addresses, and checking what Azure actually applies. From the AZ-104 outline: create and
configure virtual networks and subnets, create and configure NSGs and ASGs, and evaluate effective security rules in NSGs.

## What it deploys

- A VNet, `vnet-lab` (the first /20 of the session's address slot), with two /24 subnets: `snet-web` and `snet-app`
- Two ASGs, `asg-web` and `asg-app`, and two Standard_B1s Ubuntu 24.04 VMs with no public IP: `vm-web` (in `asg-web`) serves its name on port 80, `vm-app` (in `asg-app`) on port 8080, with python3's built-in web server
- `nsg-web` on `snet-web`: allows ssh (22) and http (80) from **VirtualNetwork**, then `deny-other-vnet` (priority 4000) denies the rest of the VNet
- `nsg-app` on `snet-app`: allows `asg-web` to reach `asg-app` on TCP 8080 (priority 100), then `deny-other-vnet` denies everything else from the VNet, ssh included
- Azure's default rules stay underneath both: the custom deny at 4000 wins over **AllowVnetInBound** at 65000

The **VirtualNetwork** service tag covers peered address space too, so while the lab is peered a tunnel client (arriving from the gateway's VNet address) can ssh to `vm-web` and browse it, but cannot reach `vm-app`. The VM user is `azureuser`; its password is behind **Show**. Reach `vm-app` from `vm-web`, or through the portal's serial console or Run command.

```text
rg-lab-<id>
  vnet-lab (slot /20)
    snet-web (/24)  nsg-web: 22, 80 from VirtualNetwork; deny the rest of the VNet
      vm-web  [asg-web]  :80
          |
          |  TCP 8080 only (asg-web -> asg-app)
          v
    snet-app (/24)  nsg-app: 8080 from asg-web; deny the rest of the VNet
      vm-app  [asg-app]  :8080
       peering (optional) <--> gateway VNet <--> WireGuard tunnel <--> you (reaches vm-web only)
```

## Things to try

- From `vm-web` (the `ssh` Connect line while peered, or the serial console) run `curl http://<vm-app address>:8080`, then `ssh azureuser@<vm-app address>`: the first answers `vm-app`, the second hangs. Find the rule that stops it.
- Open `vm-app`'s network interface and look at **Effective security rules**: both the subnet's rules and Azure's defaults, in the order they are evaluated.
- In **Network Watcher**, run **IP flow verify** from `vm-web` to `vm-app` on 8080 and on 22, and read which rule it names for each.
- Move `vm-web`'s network interface out of `asg-web` (its **Application security groups** page), repeat the curl, then put it back.
- Add an inbound rule to `nsg-app` that allows ssh from `asg-web` at priority 200, and see that the ssh from `vm-web` now gets a password prompt.
- Change `nsg-web`'s `deny-other-vnet` to priority 105, between the ssh and http rules, and work out which of the two still works before you test it.

## Learn more

- [What is Azure Virtual Network?](https://learn.microsoft.com/azure/virtual-network/virtual-networks-overview)
- [Network security groups](https://learn.microsoft.com/azure/virtual-network/network-security-groups-overview)
- [How network security groups filter network traffic](https://learn.microsoft.com/azure/virtual-network/network-security-group-how-it-works)
- [Application security groups](https://learn.microsoft.com/azure/virtual-network/application-security-groups)
- [Virtual network service tags](https://learn.microsoft.com/azure/virtual-network/service-tags-overview)
- [IP flow verify overview](https://learn.microsoft.com/azure/network-watcher/ip-flow-verify-overview)
- [Diagnose a virtual machine network traffic filter problem](https://learn.microsoft.com/azure/virtual-network/diagnose-network-traffic-filter-problem)

Anything you build by hand inside `rg-lab-az104-13-vnets` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az104-13-vnets-`.
