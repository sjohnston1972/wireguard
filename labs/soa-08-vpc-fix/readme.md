Two VPCs, an app VPC and a data VPC, joined by a peering connection: a web instance in one and a MariaDB database in the other, and VPC Flow Logs recording both. The web instance cannot reach the database. Use the tools an operator would (flow logs, Reachability Analyzer, route tables, network ACLs, security groups) to find out why, and fix it. Everything is listed in the lab's resource group, `lab-soa-08-vpc-fix`, in AWS Resource Groups (London).
From the SOA-C03 outline: troubleshoot VPC connectivity (route tables, security groups, network ACLs and peering) and analyse network traffic with VPC Flow Logs and VPC Reachability Analyzer.

## What it deploys

- `vpc-lab`, the app VPC (the slot's first /20), with `vm-web` (t4g.nano, the MariaDB client) in `snet-private-1`, the route table `rt-private` and the Instance Connect Endpoint `eice-lab`
- `vpc-data`, the data VPC (the slot's second /20), with `vm-db` (t4g.micro, MariaDB on TCP 3306, database `shop`, user `app` with the session's password) in `snet-db`, the route table `rt-data`, the network ACL `acl-db`, the security group `sg-db` and its own Instance Connect Endpoint `eice-data`
- `pcx-app-data`, the peering connection between the two VPCs
- VPC Flow Logs for both VPCs (`flow-app`, `flow-data`), every flow, one-minute records, to the log group `/cloudlabs/soa-08-vpc-fix/flow` (kept one day), written as the role `lab-soa-08-vpc-fix-flowlogs`

Sign in as `labadmin`; the password is behind **Show**, and the database user `app` has the same password. Connect from the console (EC2, the instance, Connect, EC2 Instance Connect Endpoint) or with the Connect lines. With **Peer to gateway** (only while the VPN server runs in AWS) `vm-web` is reachable from a tunnel client; `vm-db` is not, as a peering never carries traffic onward to a third network.

```text
lab-soa-08-vpc-fix (London)
  vpc-lab (app)                                  vpc-data (data)
    snet-private-1: vm-web --mysql:3306--> pcx-app-data --> snet-db [acl-db]: vm-db [sg-db], eice-data
    rt-private: vpc-data -> pcx                  rt-data: (no route back)
    eice-lab                                     vpce-s3-data
  flow-app, flow-data --> /cloudlabs/<id>/flow
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Symptom

On `vm-web`, `mysql -h <vm-db's address> -u app -p shop` (the second Connect line) waits and then fails with `Can't connect to MySQL server ... (110)`, a timeout. `vm-db` is up and MariaDB is listening: on `vm-db` itself, `sudo ss -ltn` shows `0.0.0.0:3306` and `sudo mysql -e 'SELECT 1'` answers. Find what stops the connection, fix it, and show that the command on `vm-web` now connects.

<details>
<summary>What was broken</summary>

Three faults, and the connection only works once all three are fixed:

- **The database's security group admits MySQL from the wrong /24.** `sg-db` allows TCP 3306 from `snet-private-2`'s range, where nothing runs; `vm-web` is in `snet-private-1`. A Reachability Analyzer path from `vm-web` to `vm-db` on TCP 3306 stops at `sg-db`, and the flow log for `vm-db`'s interface shows the SYNs from `vm-web` as `REJECT`. Fix: change the rule's source to `snet-private-1`'s /24 (or to `vpc-lab`'s whole range).
- **The database subnet's network ACL has no outbound rule for ephemeral ports.** `acl-db` lets 3306 in from `vpc-lab` and HTTPS out, but network ACLs are stateless: the replies from port 3306 go back to `vm-web` on a high port, and nothing allows that outbound, so they hit the final deny. With the first fault fixed, the flow log shows `vm-db`'s inbound 3306 as `ACCEPT` and its replies as `REJECT`. Fix: add an outbound rule allowing TCP 1024-65535 to `vpc-lab`'s range.
- **The data VPC's route table has no route back to the app VPC.** `rt-private` sends `vpc-data`'s range to `pcx-app-data`, but `rt-data` has no route for `vpc-lab`'s range, so the replies have nowhere to go. A peering needs a route on both sides. A Reachability Analyzer path from `vm-db` back to `vm-web` (the replies' way) shows no route; `rt-data`'s Routes tab has only `local` and the S3 endpoint. Fix: add a route to `vpc-lab`'s range through `pcx-app-data` in `rt-data`.

</details>

## Things to try

- Before fixing anything, run **Reachability Analyzer** (VPC, Network Manager, Reachability Analyzer) from `vm-web` to `vm-db` on TCP 3306, and again after each fix. Each analysis costs about 7.5p.
- In CloudWatch Logs Insights, on `/cloudlabs/soa-08-vpc-fix/flow`, run `fields @timestamp, @message | filter @message like / 3306 / | sort @timestamp desc | limit 50` and read the source, destination, ports and `ACCEPT`/`REJECT` of each record. Logs Insights charges for the data scanned (about half a penny per GB).
- With everything fixed, remove `rt-private`'s route to `vpc-data` instead. The connection fails again, but `flow-data` records nothing for it: the packets never reach the data VPC. Compare that with what the first fault looked like.
- Delete `acl-db`'s inbound rule 110 (replies to downloads) and run `sudo dnf check-update` on `vm-db`: it hangs, though nothing else changes. A security group would have let those replies in without a rule; a network ACL does not.
- With **Peer to gateway**, from a tunnel client `ssh labadmin@<vm-web>` works and `ssh labadmin@<vm-db>` does not, even with every fault fixed: the peering between the two lab VPCs never carries the VPN server's traffic onward.

## Learn more

- [Troubleshoot VPC peering connections and route tables](https://docs.aws.amazon.com/vpc/latest/peering/vpc-peering-routing.html)
- [Control subnet traffic with network access control lists](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-network-acls.html)
- [Security group rules](https://docs.aws.amazon.com/vpc/latest/userguide/security-group-rules.html)
- [Logging IP traffic using VPC Flow Logs](https://docs.aws.amazon.com/vpc/latest/userguide/flow-logs.html)
- [What is Reachability Analyzer?](https://docs.aws.amazon.com/vpc/latest/reachability/what-is-reachability-analyzer.html)

Everything this lab builds carries the tag `cloudlabs-lab = soa-08-vpc-fix` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
