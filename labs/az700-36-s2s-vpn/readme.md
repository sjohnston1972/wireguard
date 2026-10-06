A site-to-site VPN between two VNets, one of them standing in for an on-premises site: two VpnGw1AZ gateways, two local network gateways that describe the far side, and an IPsec tunnel with BGP and a custom IPsec/IKE policy. Practise reading BGP peers and learned routes, troubleshooting a connection, and breaking the tunnel on purpose to see what each mismatch looks like. From the AZ-700 outline, in Design, implement, and manage connectivity services: select a virtual network gateway SKU for site-to-site VPN, implement a virtual network gateway and a local network gateway, implement IP addressing and BGP for site-to-site VPN connections, implement a custom IPsec/IKE policy, and diagnose and resolve virtual network gateway connectivity issues. ExpressRoute and Azure Extended Network are explained under Not built here.

## What it deploys

- `vnet-azure` (the first /20 of the session's address slot) with `GatewaySubnet` (/27) and `snet-app` (/24), and `vnet-onprem` (the second /20) with `GatewaySubnet` and `snet-onprem`. The two VNets are **not** peered: the tunnel is the only way between them
- `vpngw-azure` and `vpngw-onprem`: route-based VPN gateways on the **VpnGw1AZ** SKU, active-standby, Generation1, with BGP on (ASN **65010** for Azure, **65020** for "on-prem"). Each has a Standard, zone-redundant public IP (`pip-vpngw-azure`, `pip-vpngw-onprem`). VpnGw1AZ, not Basic: Basic has no BGP and no custom IPsec policy, and the older VpnGw1 to VpnGw5 are not for new gateways
- `lgw-onprem` and `lgw-azure`, local network gateways. Each describes the other side as its own gateway would see a VPN device: its public IP, its /20, its BGP peering address and its ASN
- `cn-azure-to-onprem` and `cn-onprem-to-azure`, IPsec connections with BGP over the tunnel, one random pre-shared key (never shown) and the same IPsec/IKE policy at both ends: IKEv2 with AES256, SHA256 and DH group 14; IPsec with GCMAES256 and PFS 14; a security association lifetime of 27,000 seconds
- `vm-azure` and `vm-onprem`: Standard_B1s Ubuntu 24.04 VMs with no public IP that serve their names on port 80

Deploying takes about 45 minutes: Azure builds the two gateways side by side, and each takes 30 to 45 minutes. Tear-down takes about 25. A 2-hour session costs about £1.10 from deploy to the end of tear-down, almost all of it the two gateways. Deploy with **Peer to gateway** to reach `vm-azure` from a tunnel client, then hop across the VPN to `vm-onprem` (the Connect lines); otherwise use the serial console or Run command. The VM user is `azureuser`; its password is behind **Show**.

```text
rg-lab-<id>
  vnet-azure (slot /20 0)                          vnet-onprem (slot /20 1)
    snet-app: vm-azure :80                            snet-onprem: vm-onprem :80
    GatewaySubnet /27                                 GatewaySubnet /27
      vpngw-azure (VpnGw1AZ, AS 65010)  <== IPsec + BGP ==>  vpngw-onprem (VpnGw1AZ, AS 65020)
      cn-azure-to-onprem -> lgw-onprem              cn-onprem-to-azure -> lgw-azure
vnet-azure <--peering (optional)--> gateway VNet <--> WireGuard tunnel <--> you
```

## Things to try

- See BGP at work: `az network vnet-gateway list-bgp-peer-status -g rg-lab-az700-36-s2s-vpn -n vpngw-azure -o table` shows the peer at AS 65020 **Connected**, and `az network vnet-gateway list-learned-routes` on the same gateway shows the "on-prem" /20 learned over BGP. Open **Effective routes** on `nic-vm-azure` and find the /20 with next hop **Virtual network gateway**.
- From `vm-azure`, `curl http://<vm-onprem address>` and `ssh` to it across the tunnel. Watch the connection's **Data in** and **Data out** grow on `cn-azure-to-onprem`.
- Break it: give `cn-azure-to-onprem` a different shared key (portal: the connection's **Authentication** page, or `az network vpn-connection shared-key update`) and watch both connections go to **Not connected** and the curl stop. Put it back with the same key on both, then try changing only one end's IPsec policy (for example **PFS group** to **None**) instead.
- Run Network Watcher's **VPN troubleshoot** on `vpngw-azure` and its connection. It writes its logs to a storage account: make one in `rg-lab-az700-36-s2s-vpn` (tear-down removes it) and read the IKE log while the shared keys disagree.
- Forced tunnelling: on `vpngw-azure` set the **default site** to `lgw-onprem` (`az network vnet-gateway update --gateway-default-site lgw-onprem`), give `snet-app` a route table that sends 0.0.0.0/0 to **Virtual network gateway**, and see `vm-azure`'s internet traffic leave through "on-prem" (where nothing sends it on). Then compare route-based gateways with policy-based ones, which take one static tunnel per prefix pair and no BGP.

## Not built here

**ExpressRoute** is a private connection from your network to Microsoft through a connectivity provider, never over the internet. It cannot be built for pennies: a circuit needs a provider, a contract and a monthly port fee, so the scope check refuses every ExpressRoute resource. What the exam asks about it:

- Connectivity models: CloudExchange co-location, point-to-point Ethernet, any-to-any (IPVPN) through a provider, and **ExpressRoute Direct**, your own 10 or 100 Gbps ports straight into Microsoft's edge
- Circuit SKUs: **Local** (one or two nearby regions, no egress charge), **Standard** (the regions of one geopolitical area) and **Premium** (worldwide, more routes and VNet links); metered or unlimited data. Gateway SKUs: ErGw1AZ to ErGw3AZ and ErGwScale, in the same GatewaySubnet a VPN gateway uses
- Peerings: **private peering** reaches your VNets; **Microsoft peering** reaches Microsoft 365 and Azure public services through route filters. Each needs two /30 (or /126) link subnets and a VLAN ID
- **Global Reach** joins two on-premises sites through their ExpressRoute circuits; **FastPath** sends traffic straight to the VMs, past the gateway, on the Ultra Performance or ErGw3AZ gateways; **BFD** detects a failed link in under a second; encryption is **MACsec** on ExpressRoute Direct ports, or an IPsec site-to-site VPN over private peering
- A site-to-site VPN like this lab's makes a backup path for a circuit: the gateway prefers ExpressRoute and falls back to the VPN

**Azure Extended Network** stretches an on-premises subnet into Azure, so a VM keeps its address while it moves. A Windows Server 2022 Azure Edition VM in Azure and a Windows Server 2022 VM on-premises run the extended network feature and carry the subnet between them over VXLAN. It needs a hybrid network and Windows Server licences, so it is reading only.

## Learn more

- [What is Azure VPN Gateway?](https://learn.microsoft.com/azure/vpn-gateway/vpn-gateway-about-vpngateways)
- [About gateway SKUs](https://learn.microsoft.com/azure/vpn-gateway/about-gateway-skus)
- [About BGP and VPN Gateway](https://learn.microsoft.com/azure/vpn-gateway/vpn-gateway-bgp-overview)
- [Configure custom IPsec/IKE connection policies](https://learn.microsoft.com/azure/vpn-gateway/ipsec-ike-policy-howto)
- [Troubleshoot a site-to-site VPN connection](https://learn.microsoft.com/azure/vpn-gateway/vpn-gateway-troubleshoot-site-to-site-cannot-connect)
- [Configure forced tunneling](https://learn.microsoft.com/azure/vpn-gateway/vpn-gateway-forced-tunneling-rm)
- [What is Azure ExpressRoute?](https://learn.microsoft.com/azure/expressroute/expressroute-introduction)
- [ExpressRoute circuits and peering](https://learn.microsoft.com/azure/expressroute/expressroute-circuit-peerings)
- [Extend an on-premises subnet into Azure using extended network](https://learn.microsoft.com/azure/virtual-network/subnet-extension)

Anything you build by hand inside `rg-lab-az700-36-s2s-vpn` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az700-36-s2s-vpn-`.
