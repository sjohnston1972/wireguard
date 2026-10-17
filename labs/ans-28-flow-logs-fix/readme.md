A client VPC peered to a service VPC, where an internal Network Load Balancer fronts a small web service. The load balancer says its target is healthy, yet the client never gets an answer. VPC Flow Logs record the service VPC twice, to CloudWatch Logs and to S3 with an Athena table over them, and a traffic mirror target and filter are ready for you to copy the packets themselves. Use them, and the VPC analyzers, to find the two faults and fix them. Everything is listed in the lab's resource group, `lab-ans-28-flow-logs-fix`, in AWS Resource Groups (London).
From the ANS-C01 outline: troubleshoot network connectivity with VPC Flow Logs, traffic mirroring, Reachability Analyzer and Network Access Analyzer, and analyse flow logs at scale with Athena.

## What it deploys

- `vpc-lab`, the client VPC (the slot's first /20), with `vm-client` (t4g.nano) in `snet-private-1`, and `vpc-service` (the second /20), joined by the peering `pcx-client-service`
- In `vpc-service`: the internal NLB `nlb-<name prefix>` (Name `nlb-svc`) and the monitor `vm-monitor` in `snet-nlb`; the web service `vm-svc` (a page on port 80, security group `sg-svc`), the Instance Connect Endpoint `eice-service` and the network ACL `acl-svc` in `snet-svc`
- Flow logs of `vpc-service`: `flow-service` to the log group `/cloudlabs/ans-28-flow-logs-fix/flow` (kept one day) through the role `lab-ans-28-flow-logs-fix-flowlogs`, and `flow-service-s3` to the bucket `cloudlabs-<name prefix>-flowlogs` in hourly Hive-style folders
- The Glue database `lab_ans_28_flow_logs_fix` with the table `vpc_flow_logs` over that bucket, and the Athena workgroup `lab-ans-28-flow-logs-fix-wg` (results in the same bucket; no query may scan more than 10 MB)
- The traffic mirror target `mirror-monitor` (`vm-monitor`'s interface) and the filter `mirror-filter-web` (TCP port 80 both ways, inside the slot); no mirror session until you make one

Sign in as `labadmin`; the password is behind **Show**. With **Peer to gateway** (only while the VPN server runs in AWS) `vm-client` is reachable from a tunnel client; the service VPC is not, as a peering never carries traffic onward.

```text
lab-ans-28-flow-logs-fix (London)
  vpc-lab (client)                        vpc-service
    vm-client --TCP 80--> pcx-client-service --> snet-nlb: nlb-svc (client IP preservation) --> snet-svc [acl-svc]: vm-svc [sg-svc]
    rt-private: vpc-service -> pcx         rt-service: vpc-lab -> pcx
                                           snet-nlb: vm-monitor <--VXLAN 4789-- mirror session (by hand)
  flow-service --> /cloudlabs/<id>/flow    flow-service-s3 --> cloudlabs-<prefix>-flowlogs --> Athena vpc_flow_logs
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you (vm-client)
```

## Symptom

From `vm-client`, `curl http://<the NLB's name>` (the second Connect line) hangs or fails; the target group shows the target healthy. `vm-svc` is up and serving: on `vm-svc` itself, `curl localhost` answers "it works". Find what stops the client's requests, fix it, and show that the command on `vm-client` now gets the page.

<details>
<summary>What was broken</summary>

Two faults, and the request only works once both are fixed:

- **The service's security group admits only the load balancer's subnet, but the load balancer keeps the client's address.** `sg-svc` allows TCP 80 from `snet-nlb`'s range only. The target group has client IP preservation on, so the requests reach `vm-svc` from `vm-client`'s own address in `vpc-lab`, which `sg-svc` drops. The health checks come from the NLB's own addresses in `snet-nlb`, so the target looks healthy. The flow log for `vm-svc`'s interface shows the client's packets to port 80 as `REJECT`. Fix: allow TCP 80 from `vpc-lab`'s range in `sg-svc` (turning client IP preservation off on the target group instead also works, and also sidesteps the second fault, because `vm-svc` then replies to the NLB's address, not `vpc-lab`'s; but then `vm-svc` never sees who called).
- **The service subnet's network ACL drops the replies to the client range.** `acl-svc` has outbound rule 90 denying everything to `vpc-lab`'s range, before rule 100 allows everything out. Network ACLs are stateless, so with the first fault fixed the flow logs show the client's request to port 80 as an `ACCEPT` inbound record and `vm-svc`'s reply as a `REJECT` outbound record. Fix: delete rule 90 (or change it to allow).

</details>

## Things to try

- Read the CloudWatch copy first: in CloudWatch Logs Insights, on `/cloudlabs/ans-28-flow-logs-fix/flow`, run `fields @timestamp, @message | filter @message like / 80 / | sort @timestamp desc | limit 50`, then curl again and compare. Logs Insights charges for the data scanned (about half a penny per GB).
- Query the S3 copy with SQL: in Athena, choose the workgroup `lab-ans-28-flow-logs-fix-wg` and the database `lab_ans_28_flow_logs_fix`, then run `SELECT srcaddr, dstaddr, srcport, dstport, action, count(*) AS flows FROM vpc_flow_logs WHERE year = '2026' AND month = '10' AND day = '16' AND (dstport = 80 OR srcport = 80) GROUP BY 1, 2, 3, 4, 5 ORDER BY flows DESC` with today's date in place of the one shown. S3 files arrive every few minutes. Athena charges per data scanned (about 0.4p per 100 MB; this workgroup stops any query at 10 MB).
- Run the analyzers: Reachability Analyzer (VPC console, Network Manager) from `vm-client` to `vm-svc` on TCP 80 (the path runs through the NLB) and from `vm-svc` back to `vm-client`, before and after each fix; each analysis costs about 7.5p. Network Access Analyzer can show every path into `vpc-service` on port 80; it is charged per network interface analysed (fractions of a penny here).
- Mirror the packets: run the mirror-session Connect line (`aws ec2 create-traffic-mirror-session ...`, with the lab's tag) in CloudShell, then on `vm-monitor` run `sudo dnf install -y tcpdump && sudo tcpdump -n -i any udp port 4789` and curl from `vm-client`. While `sg-svc` still refuses the requests you see nothing: AWS never mirrors an inbound packet the source's security group or ACL drops. After that fix you see each request, wrapped in VXLAN with the client's address inside. A session costs about 1.1p per hour while it exists (delete it with `aws ec2 delete-traffic-mirror-session --traffic-mirror-session-id <id>`, or leave it to tear-down, which removes it by its lab tag).
- With everything fixed, turn client IP preservation off on the target group (EC2 console, Target groups, Attributes): the request still works, and `vm-svc`'s flow log now shows it arriving from the NLB's address. Which design would you choose, and what would you log instead?

## Learn more

- [Publish flow logs to Amazon S3](https://docs.aws.amazon.com/vpc/latest/userguide/flow-logs-s3.html)
- [Query Amazon VPC flow logs with Athena](https://docs.aws.amazon.com/athena/latest/ug/vpc-flow-logs.html)
- [What is Traffic Mirroring?](https://docs.aws.amazon.com/vpc/latest/mirroring/what-is-traffic-mirroring.html)
- [Edit target group attributes for your Network Load Balancer (client IP preservation)](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/edit-target-group-attributes.html)
- [What is Reachability Analyzer?](https://docs.aws.amazon.com/vpc/latest/reachability/what-is-reachability-analyzer.html)
- [What is Network Access Analyzer?](https://docs.aws.amazon.com/vpc/latest/network-access-analyzer/what-is-network-access-analyzer.html)

Everything this lab builds carries the tag `cloudlabs-lab = ans-28-flow-logs-fix` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
