A point-to-site VPN you sign in to with Entra ID: a VpnGw1AZ gateway with an OpenVPN configuration, a client address pool, and a VM to reach once you are connected. Practise downloading the VPN profile, connecting from your own PC with the Azure VPN Client, finding your session on the gateway, and working out why a client cannot connect. From the AZ-700 outline, in Design, implement, and manage connectivity services: select a virtual network gateway SKU for point-to-site VPN, select and configure a tunnel type, select an authentication method, configure authentication by using Microsoft Entra ID, implement a VPN client configuration file, and diagnose client-side and authentication issues. RADIUS, Always On VPN and Azure Network Adapter are explained under Not built here.

## What it deploys

- `vnet-hub` (the first /20 of the session's address slot) with `GatewaySubnet` (/27) and `snet-app` (/24)
- `vpngw-hub`, a route-based VPN gateway on the **VpnGw1AZ** SKU (active-standby, Generation1) with a Standard, zone-redundant public IP, `pip-vpngw-hub`. Basic would not do: it has no OpenVPN and no Entra ID sign-in
- Its point-to-site configuration: tunnel type **OpenVPN**, authentication **Microsoft Entra ID** with the Azure VPN Client's Microsoft-registered app as the audience (`c632b3df-fb67-4d84-bdcf-b95ad541b5c8`), so nothing is registered or consented in your tenant. The tenant and issuer are your own tenant's; the issuer must end with a slash
- A client address pool: the last /24 of the session's slot, outside every VNet, so it overlaps nothing. Connected clients get an address from it
- `vm-app`, a Standard_B1s Ubuntu 24.04 VM with no public IP in `snet-app` that serves its name on port 80
- `lab-az700-37-p2s-vpn-vpnuser`, an Entra user to sign in to the VPN as (its name is in the **users** output; its password is the session's, behind **Show**). Sign in as yourself if your account is in the same tenant; the lab user is there in case it is not

Deploying takes about 40 minutes, most of it the gateway. Tear-down takes about 20. A 2-hour session costs about £0.52 from deploy to the end of tear-down. The VM user is `azureuser`, with the same password.

```text
your PC
  Azure VPN Client (OpenVPN, Entra ID sign-in) ==internet==> pip-vpngw-hub
  WireGuard client --> gateway VNet (optional peering with vnet-hub)
rg-lab-<id>
  vnet-hub (slot /20 0)
    GatewaySubnet /27: vpngw-hub (VpnGw1AZ)   client pool: last /24 of slot /20 3
    snet-app /24: vm-app :80
Entra ID: lab-<id>-vpnuser
```

Connecting from your Windows PC, with WireGuard still running: install the **Azure VPN Client** from the Microsoft Store, download the profile (Things to try), choose **Import**, then **Connect** and sign in. Both tunnels can be up at once. The WireGuard client's Azure route carries `10.64.0.0/13`, every lab slot; the VPN client adds a route for `vnet-hub`'s /20, which is **more specific**, so traffic to this lab's VNet goes over point-to-site while it is connected and back over WireGuard when you disconnect. The client pool is inside the session's own slot and nowhere near WireGuard's tunnel addresses, so the two never clash. Your first sign-in may ask you to register for MFA (multifactor authentication) if security defaults are on.

## Things to try

- Download the VPN profile: in the portal, `vpngw-hub` → **Point-to-site configuration** → **Download VPN client**, or `az network vnet-gateway vpn-client generate -g rg-lab-az700-37-p2s-vpn -n vpngw-hub` (it prints a link to a zip). Open the zip's `AzureVPN/azurevpnconfig.xml` and find the tenant, audience and issuer.
- Import the profile into the Azure VPN Client (Windows 11 or macOS), connect, and sign in as yourself or as the lab user. Then run `ipconfig` and `route print` (or `netstat -rn`): find your address from the pool and the route to `vnet-hub`. Run `ssh azureuser@<vm-app address>` and `curl http://<vm-app address>`.
- See your session on the gateway: `vpngw-hub` → **Point-to-site sessions** lists your user name and address; disconnect it from there and watch the client notice. `az network vnet-gateway vpn-client show-health` shows the count.
- Diagnose a failure: in the profile, take the slash off the end of the issuer (or sign in with an account from another tenant), import it as a second profile and read what the client's **Diagnose** tab and its logs say. Remove it afterwards.
- Compare certificate authentication: make a self-signed root certificate, add it to the point-to-site configuration beside Entra ID (OpenVPN takes both), and see what a client then needs installed. Compare the tunnel types too: OpenVPN, IKEv2 and SSTP, and which operating systems each suits.

## Not built here

**RADIUS authentication** sends point-to-site sign-ins to your own RADIUS server (often Windows NPS, which can check Active Directory and add MFA). The gateway needs a route to that server, usually over a site-to-site VPN, so it is reading only. **Always On VPN** is Windows' own client: a device tunnel that connects before anyone signs in and a user tunnel after, both over IKEv2 with certificates. **Azure Network Adapter** is a Windows Admin Center feature that connects one Windows Server to a VNet over point-to-site, building the gateway and certificates for you. **User and group restriction** (only some users may connect) needs a custom app registration for the VPN audience, with admin consent: an identity change this lab does not make. **Certificate authentication** is in Things to try.

## Learn more

- [About point-to-site VPN](https://learn.microsoft.com/azure/vpn-gateway/point-to-site-about)
- [Configure point-to-site VPN for Microsoft Entra ID authentication](https://learn.microsoft.com/azure/vpn-gateway/point-to-site-entra-gateway)
- [Configure the Azure VPN Client for Microsoft Entra ID authentication on Windows](https://learn.microsoft.com/azure/vpn-gateway/point-to-site-entra-vpn-client-windows)
- [About gateway SKUs](https://learn.microsoft.com/azure/vpn-gateway/about-gateway-skus)
- [Configure point-to-site VPN with RADIUS authentication](https://learn.microsoft.com/azure/vpn-gateway/point-to-site-how-to-radius-ps)
- [About Always On VPN for VPN Gateway](https://learn.microsoft.com/azure/vpn-gateway/vpn-gateway-howto-always-on-device-tunnel)
- [Use Azure Network Adapter to connect a server to an Azure virtual network](https://learn.microsoft.com/windows-server/manage/windows-admin-center/azure/use-azure-network-adapter)

Anything you build by hand inside `rg-lab-az700-37-p2s-vpn` is removed at tear-down. Entra users or groups you create by hand are removed only if their name starts `lab-az700-37-p2s-vpn-`.
