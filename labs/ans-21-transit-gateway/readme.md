A transit gateway is a router you rent by the attachment: VPCs plug into it, and its route tables decide who may talk to whom. This lab plugs in three VPCs, two spokes and an egress VPC, and segments them: the spokes may not reach each other, but both reach the internet through the egress VPC's one NAT gateway. Everything is listed in the lab's resource group, `lab-ans-21-transit-gateway`, in AWS Resource Groups (London).
From the ANS-C01 outline: design and implement hub-and-spoke routing with AWS Transit Gateway, including segmentation and centralised internet egress.

## What it deploys

- Three VPCs, each a /20 of the slot: spoke A is `vpc-lab` (`snet-private-1/2`), spoke B is `vpc-spoke-b` (`snet-spoke-b-1/2`), and `vpc-egress` holds the transit gateway's subnets `snet-egress-tgw-1/2` and the public subnet `snet-egress-public` with the NAT gateway `nat-egress` and the internet gateway `igw-egress`
- The transit gateway `tgw-lab` with its default route table switched off and three attachments: `tgwa-spoke-a`, `tgwa-spoke-b` and `tgwa-egress` (in appliance mode, so a flow and its reply keep to one zone)
- Two transit gateway route tables: `tgw-rt-spokes` (both spokes are associated with it) sends `0.0.0.0/0` to the egress attachment and holds a **blackhole** route for spoke B's range; `tgw-rt-egress` (the egress attachment's) learns both spokes' ranges by propagation, so replies find their way back
- VPC routes: each spoke's default route points at `tgw-lab`; in the egress VPC, `rt-egress-tgw` sends everything to `nat-egress` and `rt-egress-public` sends the internet to `igw-egress` and the slot back to `tgw-lab`
- Two test instances serving a page naming themselves: `vm-a` (t4g.nano) in spoke A and `vm-b` (t4g.nano) in spoke B, each admitting ping and HTTP from the whole slot, so only the routing decides; Instance Connect Endpoints `eice-lab` and `eice-spoke-b`

```text
lab-ans-21-transit-gateway (London)
  vm-a (vpc-lab) ---> tgwa-spoke-a --+                      +--> tgwa-egress --> vpc-egress
  vm-b (vpc-spoke-b) -> tgwa-spoke-b -+-- tgw-rt-spokes ----+    rt-egress-tgw --> nat-egress --> igw-egress --> internet
                                      0.0.0.0/0 -> egress, spoke B /20 -> blackhole
  replies: igw-egress --> nat-egress --> rt-egress-public (slot -> tgw-lab) --> tgw-rt-egress (both spokes propagated)
  peering (optional, AWS server only, spoke A only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- Connect to `vm-a` (the first Connect line) and run `curl -s https://checkip.amazonaws.com`: the address it prints is `nat-egress`'s Elastic IP. Do the same on `vm-b` (the second line): the same address, because both spokes share one NAT gateway.
- From `vm-a`, `ping -c 3` and `curl -m 5` `vm-b`'s address: nothing answers, though `vm-b`'s security group admits both. In the VPC console, open Transit gateway route tables, `tgw-rt-spokes`, **Routes**: spoke B's range is a blackhole. Look at the **Associations** and **Propagations** tabs of both tables too.
- Now try it the other way, from `vm-b` to `vm-a`. Spoke A's range is not blackholed, so the packets follow `0.0.0.0/0` to the egress VPC. Does `vm-a` answer? Work out from the four route tables (`tgw-rt-spokes`, `rt-egress-tgw`, `rt-egress-public`, `tgw-rt-egress`) where the packets go, then add a blackhole route for spoke A's range (`vpc-lab`'s /20) to `tgw-rt-spokes` in the console and try again. Remove it afterwards.
- Open `tgwa-egress` and find **Appliance mode support: enable**. Think about why it matters when a firewall in the egress VPC must see both directions of a flow (lab 27 builds exactly that).
- Count the cost: three attachments at about 3.75p an hour each plus 2p a GB processed, against VPC peering, which has no hourly charge but needs a peering for every pair of VPCs.

**Not built here** (each needs another account or a much larger budget): AWS Cloud WAN, a managed global network of transit-gateway-like segments with a policy document, and sharing a transit gateway with other accounts through AWS RAM. Both are in the Learn more links.

## Learn more

- [How transit gateways work](https://docs.aws.amazon.com/vpc/latest/tgw/how-transit-gateways-work.html)
- [Transit gateway route tables](https://docs.aws.amazon.com/vpc/latest/tgw/tgw-route-tables.html)
- [Centralized egress to the internet](https://docs.aws.amazon.com/whitepapers/latest/building-scalable-secure-multi-vpc-network-infrastructure/centralized-egress-to-internet.html)
- [Appliance in a shared services VPC (appliance mode)](https://docs.aws.amazon.com/vpc/latest/tgw/transit-gateway-appliance-scenario.html)
- [What is AWS Cloud WAN?](https://docs.aws.amazon.com/network-manager/latest/cloudwan/what-is-cloudwan.html)
- [Share a transit gateway with AWS RAM (in Work with AWS Transit Gateway)](https://docs.aws.amazon.com/vpc/latest/tgw/transit-gateway-share.html)

Everything this lab builds carries the tag `cloudlabs-lab = ans-21-transit-gateway` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
