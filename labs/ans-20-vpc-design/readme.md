One VPC, designed the way ANS-C01 expects: more IPv4 room added to it after it was made, IPv6 handed out by AWS's IP Address Manager (IPAM) from space Amazon provides, a different way out to the internet for each address family, and a managed prefix list so that a security group names a list of ranges instead of the ranges themselves. Everything is listed in the lab's resource group, `lab-ans-20-vpc-design`, in AWS Resource Groups (London).
From the ANS-C01 outline: design IP addressing for IPv4 and IPv6, and choose and implement the right internet egress for each.

## What it deploys

- The VPC `vpc-lab` with its usual first range (the slot's first /20, subnets `snet-private-1/2`) and a **secondary IPv4 range**, the slot's second /20, holding three dual-stack subnets: `snet-dual-1/2` for instances and `snet-public` for the NAT gateway
- **IPAM** `ipam-lab` on the Free Tier, working in London only, with the pool `pool-v6` in its public scope: a /52 of Amazon-provided IPv6, of which `vpc-lab` takes a /56; each dual-stack subnet gets a /64 of that
- **Two ways out**: the internet gateway `igw-lab` (route table `rt-public`, both families) for the NAT gateway `nat-lab`; and route table `rt-dual` for the instances, sending IPv4 to `nat-lab` and IPv6 to the egress-only gateway `eigw-lab`, which lets replies in but never a new connection from outside
- The managed prefix list `pl-admin` (`lab-ans-20-vpc-design-admin`): the VPN server's VPC and `vpc-lab`'s first range
- The instance `vm-dual` (t4g.nano) in `snet-dual-1`, with an IPv4 address from the secondary range and an IPv6 address from the pool, serving a page on port 80 on both; its security group `sg-dual` admits SSH and HTTP from `pl-admin` and SSH from the Instance Connect Endpoint `eice-lab`

```text
lab-ans-20-vpc-design (London)
  ipam-lab (Free Tier) > pool-v6 (Amazon IPv6 /52) --/56--> vpc-lab
  vpc-lab: primary /20 (snet-private-1/2, eice-lab) + secondary /20 (snet-dual-1/2, snet-public)
  vm-dual (snet-dual-1) --IPv4--> rt-dual --> nat-lab (snet-public) --> igw-lab --> internet
  vm-dual (snet-dual-1) --IPv6--> rt-dual --> eigw-lab --> internet (replies only come back)
  sg-dual: SSH and HTTP from pl-admin (VPN server VPC, vpc-lab primary)
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- Connect to `vm-dual` (the first Connect line) and look at its addresses with `ip -4 addr` and `ip -6 addr`. Then go out both ways: `curl -4 -sI https://aws.amazon.com | head -1` leaves through `nat-lab`, `curl -6 -sI https://aws.amazon.com | head -1` through `eigw-lab`. Run `curl -4 -s https://checkip.amazonaws.com` too: the address it prints is the NAT gateway's Elastic IP, not anything of `vm-dual`'s.
- In the VPC console, open `vpc-lab`'s **CIDRs** tab: the primary and secondary IPv4 ranges and the IPv6 /56, whose pool is `pool-v6`. In the IPAM console (Pools, `pool-v6`, Allocations) find the same /56 allocated to `vpc-lab`, and the /52 the pool holds.
- The IPv6 address in the second Connect line is a global address, unlike `vm-dual`'s IPv4 one. From any machine with IPv6, `curl -6 -m 5 http://[<that address>]` times out: the egress-only gateway admits replies only, and `sg-dual` admits nothing from the internet either.
- Open `sg-dual`'s inbound rules: they name `pl-admin`, not addresses. In the VPC console's Managed prefix lists, open `pl-admin`, choose **Modify prefix list** and remove the `vpc-lab primary` entry; look at `sg-dual` again (its rules have not changed, but what they admit has). Put the entry back afterwards. A list's `max_entries` counts against every rule that uses it, which is why this one is 4.
- Compare the two ways out: the NAT gateway costs about 3.75p an hour plus its address and data; the egress-only gateway is free. Work out what a fleet that only ever talks IPv6 to the internet would save.

## Learn more

- [What is IPAM?](https://docs.aws.amazon.com/vpc/latest/ipam/what-it-is-ipam.html)
- [Add IPv6 support for your VPC](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-migrate-ipv6.html)
- [Add or remove a CIDR block from your VPC](https://docs.aws.amazon.com/vpc/latest/userguide/add-ipv4-cidr.html)
- [Enable outbound IPv6 traffic using an egress-only internet gateway](https://docs.aws.amazon.com/vpc/latest/userguide/egress-only-internet-gateway.html)
- [Group CIDR blocks using managed prefix lists](https://docs.aws.amazon.com/vpc/latest/userguide/managed-prefix-lists.html)

Everything this lab builds carries the tag `cloudlabs-lab = ans-20-vpc-design` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
