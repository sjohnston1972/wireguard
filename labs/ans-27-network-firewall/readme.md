A hub-and-spoke network where nothing moves without passing a firewall. Two spoke VPCs and an inspection VPC hang off one transit gateway; the transit gateway sends every packet from a spoke, whether to the other spoke or to the internet, into the inspection VPC, where AWS Network Firewall decides. A stateless rule drops ping from spoke B to spoke A, a domain allow-list lets out only AWS and Ubuntu sites, and everything else is dropped and logged. Everything is listed in the lab's resource group, `lab-ans-27-network-firewall`, in AWS Resource Groups (London).
From the ANS-C01 outline: design and implement centralised traffic inspection with AWS Network Firewall and a transit gateway, and monitor it with firewall logs.

## What it deploys

- **Spoke A**: `vpc-lab` (the slot's first /20) with `vm-a` (t4g.nano, a page on port 80) in `snet-private-1`
- **Spoke B**: `vpc-spoke-b` (the second /20) with `vm-b` in `snet-spoke-b-1` and its own Instance Connect Endpoint `eice-spoke-b`
- **Inspection**: `vpc-inspection` (the third /20) with `snet-insp-tgw` (the transit gateway's side), `snet-insp-firewall` (the firewall's endpoint) and `snet-insp-public` (the NAT gateway `nat-inspection` and the internet gateway `igw-inspection`)
- **The transit gateway** `tgw-lab`: the spokes use `tgw-rt-spokes` (everything to the inspection VPC); the inspection attachment, in appliance mode, uses `tgw-rt-inspection` (both spokes' ranges, learned by propagation)
- **The firewall** `lab-ans-27-network-firewall` with its policy `lab-ans-27-network-firewall-policy`: the stateless group `lab-ans-27-network-firewall-stateless` (drop ICMP from spoke B to spoke A, send the rest on), then the stateful group `lab-ans-27-network-firewall-domains` (HTTP host and TLS server names ending `.amazonaws.com`, `.amazon.com` or `.ubuntu.com` pass), in strict order, with every other established flow dropped and logged
- **Alert logs** in the bucket `cloudlabs-<name prefix>-nfwlogs`, under `alerts/`

A firewall takes several minutes to create and to delete, so allow up to 15 minutes each way. One firewall endpoint costs about 30p an hour, which makes this the dearest lab of the batch. Sign in as `labadmin` with the password behind **Show**.

```text
lab-ans-27-network-firewall (London)
  vm-a (vpc-lab) ---0.0.0.0/0--> tgw-lab [tgw-rt-spokes: 0.0.0.0/0 -> tgwa-inspection]
  vm-b (vpc-spoke-b) --0.0.0.0/0-^
  tgwa-inspection (appliance mode) --> snet-insp-tgw --> firewall endpoint (snet-insp-firewall) [lab-ans-27-network-firewall]
      --> internet: nat-inspection --> igw-inspection     --> other spoke: back to tgw-lab [tgw-rt-inspection]
  replies from the internet: snet-insp-public --slot--> firewall endpoint --> tgw-lab --> the spoke
  alerts --> cloudlabs-<prefix>-nfwlogs/alerts/
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you (vm-a)
```

## Things to try

- On `vm-a` run the two `curl` lines from Connect: `https://aws.amazon.com` answers, `https://example.com` connects and then hangs until the timeout. The firewall let the TCP handshake through, read the TLS server name, found no rule passing it, and dropped the rest.
- Read the alerts a few minutes later (the firewall delivers logs every few minutes). Run these in CloudShell, not on `vm-a`, which has no instance profile: the `aws s3 ls` line lists the files, and `aws s3 cp s3://<the bucket>/<a file's key> - | gunzip | head -5` shows records naming the source, the destination, `example.com` and the action, `blocked`.
- Between the spokes: on `vm-b`, `ping -c 3 <vm-a's address>` gets no answer, and the alert log never mentions it: the stateless rule dropped it before the stateful engine saw it, and stateless drops are not logged. `curl --max-time 5 http://<vm-a's address>` from `vm-b` fails too, but leaves an alert: the allow-list only passes named domains from the slot to outside it, and the policy drops everything else.
- Change the rules: in the VPC console, Network Firewall, Network Firewall rule groups, open `lab-ans-27-network-firewall-domains`, add `.example.com` to its domain list and save. A minute or so later the `example.com` line on `vm-a` answers.
- Read the routing that makes it work: in the VPC console, Transit gateway route tables, `tgw-rt-spokes` has one route (to the inspection attachment) and `tgw-rt-inspection` has both spokes' ranges. Then open `tgwa-inspection` and note appliance mode is on. This lab has one firewall zone, so you cannot see what it does here: with firewall endpoints in two or more zones, without appliance mode a reply could return through a different zone's endpoint and be dropped as half a conversation.

## Not built here

- **Firewall Manager**: applies Network Firewall, WAF and security group policies across every account of an organisation from one administrator account. It needs AWS Organizations and AWS Config across the organisation, which a lab in one account does not have.

## Learn more

- [What is AWS Network Firewall?](https://docs.aws.amazon.com/network-firewall/latest/developerguide/what-is-aws-network-firewall.html)
- [Stateful domain list rule groups](https://docs.aws.amazon.com/network-firewall/latest/developerguide/stateful-rule-groups-domain-names.html)
- [Evaluation order for stateful rules](https://docs.aws.amazon.com/network-firewall/latest/developerguide/suricata-rule-evaluation-order.html)
- [Stateful appliance in a shared services VPC](https://docs.aws.amazon.com/vpc/latest/tgw/transit-gateway-appliance-scenario.html)
- [Logging network traffic from AWS Network Firewall](https://docs.aws.amazon.com/network-firewall/latest/developerguide/firewall-logging.html)

Everything this lab builds carries the tag `cloudlabs-lab = ans-27-network-firewall` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
