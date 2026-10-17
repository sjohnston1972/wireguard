A site-to-site VPN from AWS to a data centre, where the data centre is pretend: a second VPC whose one router, an Ubuntu instance with a public address, plays the office's VPN box. AWS's end is a virtual private gateway on `vpc-lab`; the router brings up both of AWS's IPsec tunnels with strongSwan and swaps routes with it by BGP using FRR, so neither side has a route to the other typed in. Everything is listed in the lab's resource group, `lab-ans-22-s2s-vpn`, in AWS Resource Groups (London).
From the ANS-C01 outline: implement hybrid connectivity with AWS Site-to-Site VPN and dynamic routing with BGP, and monitor and troubleshoot it.

## What it deploys

- **AWS side**: the virtual private gateway `vgw-lab` (ASN 64512) on `vpc-lab`, putting what it learns by BGP into `rt-private`; the instance `vm-aws` (t4g.nano) in `snet-private-1`, serving a page and admitting ping and HTTP from the on-prem VPC (`sg-aws`)
- **The VPN**: the customer gateway `cgw-onprem` (the router's Elastic IP, ASN 65001) and the VPN connection `vpn-lab`, two IPsec tunnels (IKEv2, a 32-letter pre-shared key each) to two different AWS endpoints, with BGP over each
- **Pretend data centre**: the VPC `vpc-onprem` (the slot's second /20) with the subnet `snet-onprem`, the internet gateway `igw-onprem` and the route table `rt-onprem`, which sends `vpc-lab`'s range to the router as an office LAN would; the router `vm-router` (Ubuntu 24.04, t4g.micro) at a fixed address with the Elastic IP `eip-router`, strongSwan (one route-based tunnel interface per tunnel) and FRR; its security group `sg-router` admits IKE and IPsec (UDP 500 and 4500) only from the two tunnel endpoints and SSH only from `eice-onprem`
- Instance Connect Endpoints `eice-lab` (for `vm-aws`) and `eice-onprem` (for `vm-router`)

The tunnels come up a few minutes after the router boots (it installs strongSwan and FRR first); the lab counts as ready as soon as AWS says the VPN connection is available.

```text
lab-ans-22-s2s-vpn (London)
  vm-aws (vpc-lab, snet-private-1) -- rt-private (BGP-learned on-prem /20) --> vgw-lab (ASN 64512)
  vgw-lab == vpn-lab: tunnel 1 + tunnel 2 (IPsec, IKEv2, BGP) ==> cgw-onprem = eip-router
  eip-router --> vm-router (vpc-onprem, snet-onprem; strongSwan vti1/vti2, FRR ASN 65001)
  rt-onprem: vpc-lab /20 --> vm-router, 0.0.0.0/0 --> igw-onprem
  peering (optional, AWS server only, vpc-lab only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- In the VPC console, open Site-to-Site VPN connections, `vpn-lab`, **Tunnel details**: both tunnels should read **Up** with 1 BGP route each within ten minutes of deploy. Then open `rt-private`'s routes: the on-prem /20 is there, **Propagated: Yes**, to `vgw-lab`.
- Connect to `vm-router` (the second Connect line) and run the third: `sudo swanctl --list-sas` shows both IKE and child security associations, `sudo vtysh -c 'show ip bgp summary'` both neighbours Established with routes received. `sudo vtysh -c 'show ip route bgp'` shows `vpc-lab`'s /20 learned over the two tunnel interfaces.
- From `vm-router`, reach `vm-aws` through the VPN from the router's own address: `ping -I <vm-router's address> <vm-aws's address>` and `curl --interface <vm-router's address> http://<vm-aws's address>` (both addresses are in the dashboard).
- Fail a tunnel: on `vm-router` run `sudo swanctl --terminate --ike aws1`. Watch the console's Tunnel details (tunnel 1 goes Down) and `show ip bgp summary`; a `ping` left running from the router keeps answering through tunnel 2 once BGP notices (up to 30 seconds, the hold time). Bring tunnel 1 back with `sudo swanctl --initiate --child aws1`: AWS waits for the router to start a tunnel, it never starts one itself.
- In the console, choose **Download configuration** on `vpn-lab` (vendor strongSwan) and compare AWS's suggested settings with the router's own files, `/etc/swanctl/conf.d/aws.conf` and `/etc/frr/frr.conf`.

**Not built here** (each needs a physical circuit or costs far more than a lab): AWS Direct Connect (connections, virtual interfaces, link aggregation groups, MACsec, Direct Connect gateways and SiteLink), and accelerated VPN, which runs the tunnels over Global Accelerator's network. Both are in the Learn more links.

## Learn more

- [How AWS Site-to-Site VPN works](https://docs.aws.amazon.com/vpn/latest/s2svpn/how_it_works.html)
- [Site-to-Site VPN tunnel options](https://docs.aws.amazon.com/vpn/latest/s2svpn/VPNTunnels.html)
- [Monitor your Site-to-Site VPN connection](https://docs.aws.amazon.com/vpn/latest/s2svpn/monitoring-overview-vpn.html)
- [Accelerated Site-to-Site VPN connections](https://docs.aws.amazon.com/vpn/latest/s2svpn/accelerated-vpn.html)
- [What is AWS Direct Connect?](https://docs.aws.amazon.com/directconnect/latest/UserGuide/Welcome.html)

Everything this lab builds carries the tag `cloudlabs-lab = ans-22-s2s-vpn` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
