Three VNets with no peerings of their own, joined into a hub and spoke by **Azure Virtual Network Manager** (AVNM), which
also applies **security admin rules** that are evaluated before any NSG. Practise network groups, static membership,
connectivity and security admin configurations, and deployments, and see an AlwaysAllow rule override an NSG. From the
AZ-700 outline (Design and implement core networking infrastructure, and Design and implement Azure network security
services): design and implement Azure Virtual Network Manager, hub-and-spoke connectivity, and security admin rules.

## What it deploys

- `vnet-hub`, `vnet-spoke1` and `vnet-spoke2` from the first three /20s of the session's address slot, each with one /24 subnet, and **no peerings** in the Terraform
- `avnm-<prefix>`, a network manager in the lab's resource group with the **Connectivity** and **SecurityAdmin** features. Its scope is the subscription (AVNM scopes can only be subscriptions or management groups), but it only ever touches its group's members
- `ng-spokes`, a network group with two **static members**: the two spokes
- `cc-hub-spoke`, a hub-and-spoke connectivity configuration: hub `vnet-hub`, spokes **directly connected** to each other, no global mesh, no hub gateway, and **delete existing peerings** off, so the hub's peering with the gateway stays
- `sac-lab`, a security admin configuration with the rule collection `rc-spokes` on `ng-spokes`: `deny-ssh-internet` (Deny, inbound TCP 22 from the **Internet** service tag, priority 100) and `always-allow-hub-ssh` (**AlwaysAllow**, inbound TCP 22 from the hub's /20, priority 90)
- Two **deployments**, Connectivity and SecurityAdmin, committing both configurations in the session's region. Nothing applies until it is deployed
- `nsg-spoke1` and `nsg-spoke2` on the spokes' subnets, each denying TCP 22 from the hub's /20: the AlwaysAllow admin rule overrides that deny
- `vm-spoke1` and `vm-spoke2`: Standard_B1s Ubuntu 24.04 VMs with no public IP that serve their names on port 80 with python3's built-in web server

The pipeline peers only the hub with the gateway, and peering is not transitive, so the spokes cannot be reached over the tunnel: use the portal's serial console or Run command on the spoke VMs (user `azureuser`, password behind **Show**). From one spoke the other answers directly.

**Never add `vnet-wg` (or any VNet that is not this lab's) to a network group.** The manager's scope is the whole subscription, so a member you add by hand could be any VNet in it: AVNM would peer it with this lab's hub and put the deny rule in front of its NSGs. The lab's own Terraform only ever adds its two spokes, and the scope check refuses anything else.

```text
rg-lab-<id>
  avnm-<prefix> (scope: this subscription; Connectivity, SecurityAdmin)
    ng-spokes = { vnet-spoke1, vnet-spoke2 }   (static members)
    cc-hub-spoke  --deployed-->  ANM_ peerings hub <-> each spoke, spoke <-> spoke
    sac-lab/rc-spokes --deployed--> on both spokes, before their NSGs:
        90  AlwaysAllow  TCP 22 from hub /20
       100  Deny         TCP 22 from Internet

  vnet-hub (slot /20 #0)  <-- peering (optional) <--> gateway VNet <--> tunnel <--> you
     ^ ANM_ peering           ^ ANM_ peering
  vnet-spoke1 (/20 #1)  <-->  vnet-spoke2 (/20 #2)    (directly connected)
    vm-spoke1 :80 [nsg-spoke1]  vm-spoke2 :80 [nsg-spoke2]
```

## Things to try

- Open `vnet-spoke1` in the portal: **Peerings** lists the `ANM_` peerings AVNM made, and **Network manager** shows the connectivity and security admin configurations applied to it. From `vm-spoke1`, `curl http://<vm-spoke2 address>` answers through the direct connection between spokes.
- In Network Watcher, run **IP flow verify** on `vm-spoke1`, inbound TCP 22, first from an internet address such as 203.0.113.10 (denied by `deny-ssh-internet`), then from an address in the hub's /20 (allowed by `always-allow-hub-ssh`, even though `nsg-spoke1` denies it).
- Add a mesh connectivity configuration for `ng-spokes`, deploy it alongside `cc-hub-spoke`, and see how the effective routes on `vm-spoke1`'s network interface change. Remove it from the deployment after.
- Deploy **None**: in the network manager, **Deployments**, remove `cc-hub-spoke` from the region's Connectivity deployment, and watch the `ANM_` peerings go (and come back when you deploy it again). Tear-down does the same for every configuration before it deletes anything.
- Read why dynamic membership needs Azure Policy: a policy with the `addToNetworkGroup` effect, assigned at a subscription or management group. That would reach every VNet in the subscription, so it is never built here; static members keep the lab inside its own VNets.

## Learn more

- [What is Azure Virtual Network Manager?](https://learn.microsoft.com/azure/virtual-network-manager/overview)
- [Network groups in Azure Virtual Network Manager](https://learn.microsoft.com/azure/virtual-network-manager/concept-network-groups)
- [Connectivity configuration in Azure Virtual Network Manager](https://learn.microsoft.com/azure/virtual-network-manager/concept-connectivity-configuration)
- [Security admin rules in Azure Virtual Network Manager](https://learn.microsoft.com/azure/virtual-network-manager/concept-security-admins)
- [Deployments in Azure Virtual Network Manager](https://learn.microsoft.com/azure/virtual-network-manager/concept-deployments)
- [IP flow verify overview](https://learn.microsoft.com/azure/network-watcher/ip-flow-verify-overview)

Anything you build by hand inside `rg-lab-az700-33-vnet-manager` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az700-33-vnet-manager-`.
