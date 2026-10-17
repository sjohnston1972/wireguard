Two ways to join a VPC in London to one in Ireland, side by side: a transit gateway in each Region joined by a peering attachment, and a plain inter-Region VPC peering. One Ireland instance sits behind each path, so you can ping both from London and compare. Everything is listed in the lab's resource groups, `lab-ans-29-multi-region`, in AWS Resource Groups (London and Ireland).
From the ANS-C01 outline: design and implement connectivity across AWS Regions with transit gateway peering and VPC peering, and choose between them.

## What it deploys

- **London**: the VPC `vpc-lab` with `vm-london` (t4g.nano) in `snet-private-1`, and the transit gateway `tgw-london` (ASN 64512) attached to it (`tgwa-london`). Its route table `rt-private` sends `snet-ireland-tgw`'s /24 to `tgw-london` and `snet-ireland-pcx`'s /24 to the VPC peering
- **Ireland**: the VPC `vpc-ireland` (the slot's second /20) with two subnets, each with its own route table back to London's /20: `snet-ireland-tgw` (`rt-ireland-tgw`, through `tgw-ireland`) holding `vm-ireland-tgw`, and `snet-ireland-pcx` (`rt-ireland-pcx`, through the VPC peering) holding `vm-ireland-pcx`; the transit gateway `tgw-ireland` (ASN 64513) attached in both subnets (`tgwa-ireland`); an S3 gateway endpoint and the Instance Connect Endpoint `eice-ireland`
- **Transit gateway peering**: the peering attachment `tgwp-london-ireland`, requested in London and accepted in Ireland; a transit gateway peering never learns routes, so each side has its own route table (`tgw-rt-london`, `tgw-rt-ireland`; the transit gateways' default route tables are off), with the VPC attachment and the peering attachment associated, the VPC's /20 propagated, and a static route to the other side's /20 through the peering attachment
- **VPC peering**: `pcx-london-ireland`, requested in London and accepted in Ireland (an inter-Region request is never accepted automatically)

It takes up to a quarter of an hour: each peering waits for its accept, and the transit gateways and their attachments take a few minutes each.

```text
lab-ans-29-multi-region
  London: vm-london (vpc-lab) -- rt-private --+-- snet-ireland-tgw /24 --> tgw-london
                                              +-- snet-ireland-pcx /24 --> pcx-london-ireland
  tgw-london <== tgwp-london-ireland (static routes both sides) ==> tgw-ireland (Ireland)
  Ireland: tgw-ireland --> vm-ireland-tgw (snet-ireland-tgw, rt-ireland-tgw)
  Ireland: pcx-london-ireland --> vm-ireland-pcx (snet-ireland-pcx, rt-ireland-pcx)
  peering (optional, AWS server only, vpc-lab only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- Connect to `vm-london` (the first Connect line) and run the fourth line's two pings. Compare the round-trip times: both cross the Irish Sea on AWS's network, one through two transit gateways and one directly. Run `curl` against both instances' addresses too: each page says which path it was reached by.
- In the VPC console (London), open Transit gateway route tables and `tgw-rt-london`: London's /20 is **propagated** from `tgwa-london`, Ireland's /20 is a **static** route to the peering attachment. Switch the console to Ireland (eu-west-1) and look at `tgw-rt-ireland`: the mirror image.
- Break the transit gateway path: in Ireland, delete the static route to London's /20 from `tgw-rt-ireland`. The ping to `vm-ireland-tgw` stops; the one to `vm-ireland-pcx` carries on. Add the route back (London's /20, attachment `tgwp-london-ireland`).
- Connect to `vm-ireland-tgw` (the second Connect line, note `--region`) and `curl` `vm-london`'s address: the reply takes the same path back, because London's route table names this /24 explicitly.
- Weigh the two: a transit gateway charges for each attachment hour on both sides and for every GB sent into it from a VPC, but joins many VPCs and Regions with one hub; VPC peering has no hourly charge and no processing charge, only the inter-Region data, but every pair of VPCs needs its own peering and peering is never transitive.

## Learn more

- [Transit gateway peering attachments](https://docs.aws.amazon.com/vpc/latest/tgw/tgw-peering.html)
- [Add a route to a transit gateway route table for a peering attachment](https://docs.aws.amazon.com/vpc/latest/tgw/tgw-peering-add-route.html)
- [Inter-Region VPC peering](https://docs.aws.amazon.com/vpc/latest/peering/what-is-vpc-peering.html)
- [Transit gateway design best practices](https://docs.aws.amazon.com/vpc/latest/tgw/tgw-best-design-practices.html)
- [Amazon VPC-to-Amazon VPC connectivity options](https://docs.aws.amazon.com/whitepapers/latest/aws-vpc-connectivity-options/amazon-vpc-to-amazon-vpc-connectivity-options.html)

Everything this lab builds carries the tag `cloudlabs-lab = ans-29-multi-region` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
