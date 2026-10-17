Hybrid DNS the way most companies run it: a cloud VPC and a data centre that each keep their own private names, and Route 53 Resolver joining them in both directions. The data centre here is pretend (a second VPC with a dnsmasq server), but every AWS piece is the real thing: inbound and outbound Resolver endpoints, a forwarding rule, a private hosted zone, a DNS Firewall rule and query logging to S3. Everything is listed in the lab's resource group, `lab-ans-23-hybrid-dns`, in AWS Resource Groups (London); the private hosted zone is a global Route 53 item, under Route 53 in the console.
From the ANS-C01 outline: design DNS solutions that meet public, private and hybrid requirements; implement Route 53 Resolver endpoints and forwarding rules; protect and log DNS with DNS Firewall and query logging.

## What it deploys

- **Cloud**: the VPC `vpc-lab` with `vm-cloud` (t4g.nano, a page naming itself) and the private hosted zone `cloud.<name prefix>.internal`, whose record `app` is vm-cloud's address
- **Data centre**: the VPC `vpc-onprem` (the slot's second /20), peered to `vpc-lab` by the lab itself (`pcx-cloud-onprem`), with `vm-dns`, a dnsmasq server at a fixed address that answers `app.corp.<name prefix>.internal` itself and sends questions about `cloud.<name prefix>.internal` to AWS
- **Resolver inbound endpoint** `rslvr-in`: two addresses in `vpc-lab` (one in each private subnet, chosen by AWS) that vm-dns forwards cloud questions to
- **Resolver outbound endpoint** `rslvr-out` (two more addresses, one in each private subnet) and the forwarding rule `rule-corp`: anything in `vpc-lab` that asks about `corp.<name prefix>.internal` is sent through it to vm-dns
- **DNS Firewall**: the rule group `dnsfw-group` on `vpc-lab`, with one rule that answers NXDOMAIN for `example.com` and every name under it
- **Query logging**: every question asked in `vpc-lab` is written to the bucket `cloudlabs-<name prefix>-dnslogs`

It takes about 8 minutes: the two Resolver endpoints are the slow part.

```text
lab-ans-23-hybrid-dns (London)
  vm-cloud (vpc-lab) --"app.corp?"--> VPC resolver --rule-corp--> rslvr-out --peering--> vm-dns dnsmasq (vpc-onprem)
  vm-dns dnsmasq --"app.cloud?"--> rslvr-in --> private zone cloud.<prefix>.internal --> vm-cloud's address
  vpc-lab questions --> DNS Firewall (example.com: NXDOMAIN) --> query logs --> cloudlabs-<prefix>-dnslogs
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- Cloud asks the data centre: connect to `vm-cloud` (the first Connect line) and run `dig app.corp.<name prefix>.internal` (the third line). The answer is vm-dns's address. In a second tab connect to `vm-dns` and run `sudo journalctl -u lab-dns -f` while you ask again: the question arrives from one of `rslvr-out`'s addresses, not from vm-cloud, because the outbound endpoint asks on its behalf. The dashboard's address list names them; `aws route53resolver list-resolver-endpoint-ip-addresses --resolver-endpoint-id <id>` shows them too.
- The data centre asks the cloud: on `vm-dns` run the fourth Connect line, `dig @<vm-dns address> app.cloud.<name prefix>.internal`. dnsmasq forwards it to `rslvr-in`'s two addresses, which answer from the private zone. Then `curl http://$(dig +short @<vm-dns address> app.cloud.<name prefix>.internal)` fetches vm-cloud's page across the peering by name.
- DNS Firewall: on `vm-cloud` run `dig example.com` and `dig www.example.com`: both NXDOMAIN, while `dig aws.amazon.com` answers. On `vm-dns` run `dig example.com` (Amazon's resolver in `vpc-onprem`, which has no firewall association): it answers. In the Route 53 Resolver console, DNS Firewall, `dnsfw-group`, change the rule's action to Alert and see `vm-cloud` get an answer again.
- Query logs: after about ten minutes, open the bucket `cloudlabs-<name prefix>-dnslogs` in the S3 console. Under `AWSLogs/<account>/vpcdnsquerylogs/` are compressed files, one JSON line per question: open one and find your `example.com` question with its `BLOCK` firewall action, and the corp question with the rule that forwarded it.
- Turn the forwarding off: in the Route 53 Resolver console, Rules, `lab-ans-23-hybrid-dns-corp`, disassociate `vpc-lab`, and ask the corp question again from `vm-cloud`: NXDOMAIN, because Amazon's resolver has never heard of `corp`. Associate it again to put it back.

## Learn more

- [What is Amazon Route 53 Resolver?](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resolver.html)
- [Forwarding inbound DNS queries to your VPCs](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resolver-forwarding-inbound-queries.html)
- [Forwarding outbound DNS queries to your network](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resolver-forwarding-outbound-queries.html)
- [Route 53 Resolver DNS Firewall](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resolver-dns-firewall.html)
- [Resolver query logging](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resolver-query-logs.html)

Everything this lab builds carries the tag `cloudlabs-lab = ans-23-hybrid-dns` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
