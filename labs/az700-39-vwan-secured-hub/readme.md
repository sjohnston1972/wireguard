A Virtual WAN with a secured hub: a Standard hub with Azure Firewall Basic inside it, routing intent sending both private and internet traffic through the firewall, and two spoke VNets connected to the hub. Practise reading a hub's effective routes, filtering spoke-to-spoke and internet traffic in a firewall policy, and comparing a secured hub with the hub VNet of lab 38. From the AZ-700 outline: in Design, implement, and manage connectivity services, select a Virtual WAN SKU, design a Virtual WAN architecture, create a hub in Virtual WAN and configure virtual hub routing; in Design and implement Azure network security services, create a secure hub by deploying Azure Firewall inside a Virtual WAN hub and create Firewall Manager policies. Hub gateways and third-party NVAs are explained under Not built here.

## What it deploys

- `vwan-lab`, a **Standard** virtual WAN, and `vhub-lab`, its hub, with a /23 address prefix (the first /23 of the slot's fourth /20) where Azure runs the hub's routers
- `afw-vhub`, an Azure Firewall on the **Basic** tier inside the hub, which makes it a secured hub. It has no subnet and no public IP resource of its own: Azure gives it one public IP
- `fwp-vhub`, a Basic Firewall Manager policy: network rules letting the spokes reach each other on TCP 22 and ping, and an application rule letting them reach `*.ubuntu.com` on HTTP and HTTPS. Anything else is denied
- Routing intent, `ri-vhub`: a **private traffic** policy (the RFC 1918 ranges) and an **internet traffic** policy (0.0.0.0/0), both with the firewall as next hop
- `vnet-spoke1` and `vnet-spoke2` (the first and second /20s), connected to the hub (`conn-spoke1`, `conn-spoke2`) with internet security on, so they learn the hub's 0.0.0.0/0. Their `snet-workload` subnets have **no default outbound access**: the firewall is the only way out
- `vm-spoke1` and `vm-spoke2`: Standard_B1s Ubuntu 24.04 VMs with no public IP that serve their names on port 80

Deploying takes about 35 minutes: the hub takes about 30, the firewall a few more, then the connections and routing intent, one at a time. Tear-down takes about 30, in the reverse order. A 2-hour session costs about £1.60 from deploy to the end of tear-down, most of it the hub and its firewall. There is no **Peer to gateway** for this lab: a virtual hub owns its connections, and the gateway's VNet cannot be peered with it. Reach the VMs through the portal's serial console or Run command, and go from one spoke to the other from there. The VM user is `azureuser`; its password is behind **Show**.

```text
rg-lab-<id>
  vwan-lab (Standard)
    vhub-lab (/23 from slot /20 3)
      afw-vhub (Basic, secured hub) -- policy fwp-vhub --> its own public IP --> internet
      ri-vhub: PrivateTraffic -> afw-vhub, Internet -> afw-vhub
         |                                   |
     conn-spoke1                         conn-spoke2
  vnet-spoke1 (slot /20 0)            vnet-spoke2 (slot /20 1)
    snet-workload: vm-spoke1 :80        snet-workload: vm-spoke2 :80
```

## Things to try

- Read the hub's routes: `az network vhub get-effective-routes -g rg-lab-az700-39-vwan-secured-hub -n vhub-lab --resource-type HubVirtualNetworkConnection --resource-id <conn-spoke1's id>` (the Connect lines have it), or the hub's **Effective Routes** in the portal. Find 0.0.0.0/0 and the private ranges with the firewall as next hop. Then open **Effective routes** on `nic-vm-spoke1`.
- On `vm-spoke1` (serial console), `ssh azureuser@<vm-spoke2 address>` and `ping` it: spoke-to-spoke traffic crosses the hub's firewall. `curl http://<vm-spoke2 address>` is denied, as no rule allows port 80.
- Internet through the firewall: on `vm-spoke1`, `sudo apt update` works (`*.ubuntu.com`) while `curl -sI https://www.microsoft.com` is refused. Add `www.microsoft.com` to `fwp-vhub` in **Firewall Manager** and try again.
- Turn **internet security** off on `conn-spoke2` and see 0.0.0.0/0 disappear from its effective routes, and its internet access with it (its subnet has no default outbound access). Turn it back on.
- Compare the SKUs: a **Basic** virtual WAN has site-to-site VPN only, with no VNet-to-VNet transit through the hub, no firewall and no routing intent; **Standard** has them all. Compare this secured hub with lab 38's hub VNet: who manages the routing, the subnets and the public IPs?

## Not built here

**Gateways in a hub.** A Standard hub can also hold a **site-to-site VPN gateway**, a **point-to-site VPN gateway** (User VPN) and an **ExpressRoute gateway**, each sized in **scale units** (a site-to-site scale unit is 500 Mbps, a point-to-site one 500 Mbps and 500 connections, an ExpressRoute one 2 Gbps), and each takes about 30 minutes to build and bills every hour for every scale unit. They are left out to keep this lab's deploy time and cost down; with routing intent on, traffic from branches and VPN users goes through the hub's firewall too. **Third-party NVAs in the hub**: some partners' firewalls and SD-WAN appliances can run inside a hub as managed applications, and some can be routing intent's next hop instead of Azure Firewall. They need marketplace terms and licences, so they are reading only. A hub can also peer over BGP with an NVA in a spoke VNet.

## Learn more

- [What is Azure Virtual WAN?](https://learn.microsoft.com/azure/virtual-wan/virtual-wan-about)
- [Virtual WAN global transit network architecture](https://learn.microsoft.com/azure/virtual-wan/virtual-wan-global-transit-network-architecture)
- [About virtual hub routing](https://learn.microsoft.com/azure/virtual-wan/about-virtual-hub-routing)
- [How to configure Virtual WAN hub routing intent and routing policies](https://learn.microsoft.com/azure/virtual-wan/how-to-routing-policies)
- [What is a secured virtual hub?](https://learn.microsoft.com/azure/firewall-manager/secured-virtual-hub)
- [About Network Virtual Appliances in a Virtual WAN hub](https://learn.microsoft.com/azure/virtual-wan/about-nva-hub)
- [Virtual WAN FAQ](https://learn.microsoft.com/azure/virtual-wan/virtual-wan-faq)

Anything you build by hand inside `rg-lab-az700-39-vwan-secured-hub` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az700-39-vwan-secured-hub-`.
