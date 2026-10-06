Watching and securing a VNet: two VMs you can only SSH to through Azure Bastion, NSGs whose decisions you can test with IP flow verify, and a VNet flow log with traffic analytics recording every flow. From the AZ-700 outline, in Design and implement Azure network security services: create and associate NSGs, verify NSG flow rules with IP flow verify, configure flow logs, and deploy Azure Bastion with the AzureBastionSubnet NSG. And in Design and implement core networking infrastructure: monitor networks with Network Watcher, VNet flow logs and traffic analytics.

## What it deploys

- `vnet-hub` (the first /20 of the session's address slot) with `AzureBastionSubnet` (a /26, the smallest Bastion takes), `snet-web` and `snet-app` (each a /24)
- `bas-hub`, **Azure Bastion Basic** with a Standard public IP: the only way to SSH to the VMs, from the portal
- `nsg-bastion` on `AzureBastionSubnet` with the rules Learn documents: inbound 443 from Internet, GatewayManager and AzureLoadBalancer, 8080 and 5701 within the VirtualNetwork; outbound 22 and 3389 to the VirtualNetwork, 443 to AzureCloud, 8080 and 5701 within the VirtualNetwork, 80 to the Internet
- `vm-web` and `vm-app`: Standard_B1s Ubuntu 24.04 VMs with no public IP, serving their names on port 80, each with the Network Watcher agent
- `nsg-web`: SSH only from the Bastion subnet, everything from `snet-app` denied. `nsg-app`: SSH only from the Bastion subnet, port 80 from `snet-web`, everything else from the VNet denied
- `<prefix>flow`, an LRS storage account for the flow logs, and `log-flow`, a Log Analytics workspace capped at 0.05 GB a day
- `lab-az700-44-flow-logs-bastion-vnet`, a **VNet flow log** (version 2, kept 1 day) on the region's own Network Watcher, `NetworkWatcher_<region>`, which lives in Azure's `NetworkWatcherRG`: logging `vnet-hub` into `<prefix>flow`, with **traffic analytics** every 10 minutes into `log-flow`

This lab never makes a Network Watcher: Azure keeps one per region per subscription in `NetworkWatcherRG`, and the flow log is a child of it. That is why the flow log is the one thing a lab may put outside its own group (scope exception S2, approved by Steven): it must be named `lab-<id>-`, log only this lab's VNet into this lab's account and workspace, and the tear-down's safety net deletes it by name if deleting the VNet has not already. Traffic analytics adds a data collection rule and endpoint (`NWTA...`) to the workspace's group, this lab's. Bastion takes about 10 minutes to create and about as long to delete. With **Peer to gateway**, a tunnel client reaches port 80 on `vm-web` but never SSH. The VM user is `azureuser`; its password is behind **Show**.

```text
rg-lab-<id>
  vnet-hub (slot /20)  <-- flow log lab-<id>-vnet (in NetworkWatcherRG, on NetworkWatcher_<region>)
    AzureBastionSubnet (/26)  nsg-bastion (Learn's rules)    --> <prefix>flow (blobs)
      bas-hub (Basic) <-- pip-bastion <-- you (portal, 443)  --> log-flow (traffic analytics, 10 min)
         | SSH 22
    snet-web (/24)  nsg-web: 22 from Bastion only, deny from snet-app
      vm-web :80  ----- 80 allowed ----->
    snet-app (/24)  nsg-app: 22 from Bastion only, 80 from snet-web, deny other VNet
      vm-app :80  ----- 80 denied ------> vm-web
       peering (optional) <--> gateway VNet <--> WireGuard tunnel <--> you (port 80 on vm-web)
```

## Things to try

- SSH to `vm-web` through Bastion (the VM, **Connect**, **Bastion**), then `curl http://<vm-app address>` (allowed) and, from `vm-app`, `curl http://<vm-web address>` (denied, it times out).
- Run **IP flow verify** (Network Watcher) for both flows and for SSH from the tunnel, and read which rule decides each. Then **NSG diagnostics** for the same flows; compare the two tools.
- After 10 to 15 minutes, open `<prefix>flow`, container `insights-logs-flowlogflowevent`, and read a flow log blob: find the allowed and denied flows. In `log-flow`, query `NTANetAnalytics | take 20` and the Traffic analytics workbook.
- Remove a rule Bastion needs from `nsg-bastion` (AllowGatewayManagerInbound, say) and watch Bastion stop working or report its NSG as wrong; restore it. Which rules can never be removed, and why does Bastion need outbound 443 to AzureCloud?
- Compare Bastion's SKUs: **Bastion Developer** is free, needs no subnet or public IP and connects one VM at a time from the portal, without peering; Basic and up need `AzureBastionSubnet`, and Standard adds native client SSH (`az network bastion ssh`), scaling and IP-based connections.

## Not built here

- **DDoS Network Protection** (a plan, about £2,200 a month, covering every public IP in its VNets) and **DDoS IP Protection** (per public IP, about £150 a month each): Azure's free infrastructure protection covers this lab's IP. The scope check refuses both.
- **Defender for Cloud** network recommendations: Secure Score items for NSGs and open management ports, attack path analysis and Cloud Security Explorer queries need Defender plans on the subscription.
- **Azure Monitor network insights** (the Network Insights page, topology and connection monitor): they read the same Network Watcher data this lab produces, at no build cost, so open them in the portal while the lab runs.

## Learn more

- [What is Azure Bastion?](https://learn.microsoft.com/azure/bastion/bastion-overview)
- [Working with NSG access and Azure Bastion](https://learn.microsoft.com/azure/bastion/bastion-nsg)
- [Bastion configuration settings and SKUs](https://learn.microsoft.com/azure/bastion/configuration-settings)
- [Virtual network flow logs](https://learn.microsoft.com/azure/network-watcher/vnet-flow-logs-overview)
- [Traffic analytics](https://learn.microsoft.com/azure/network-watcher/traffic-analytics)
- [IP flow verify overview](https://learn.microsoft.com/azure/network-watcher/ip-flow-verify-overview)
- [NSG diagnostics overview](https://learn.microsoft.com/azure/network-watcher/nsg-diagnostics-overview)
- [Azure DDoS Protection overview](https://learn.microsoft.com/azure/ddos-protection/ddos-protection-overview)

Anything you build by hand inside `rg-lab-az700-44-flow-logs-bastion` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az700-44-flow-logs-bastion-`.
