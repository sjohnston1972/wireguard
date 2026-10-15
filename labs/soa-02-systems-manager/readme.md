Two Amazon Linux instances you manage without SSH: Systems Manager runs commands, opens shell sessions, scans for patches and keeps an inventory through private endpoints, and AWS Config watches the lab's security groups and removes SSH opened to the internet by itself. Everything is listed in the lab's resource group, `lab-soa-02-systems-manager`, in AWS Resource Groups (London).
From the SOA-C03 outline: manage instances with AWS Systems Manager (Run Command, Session Manager, Patch Manager, State Manager), evaluate compliance with AWS Config rules, and remediate automatically with Systems Manager Automation.

## What it deploys

- A VPC, `vpc-lab` (the first /20 of the session's address slot), with two private subnets and no route to the internet: interface endpoints for `ssm`, `ssmmessages` and `ec2messages` carry Systems Manager's traffic, and an S3 gateway endpoint carries package downloads and patches
- `vm-web1` and `vm-web2`, t4g.micro Amazon Linux 2023 instances with no public IP, one in each subnet, with the role `lab-soa-02-systems-manager-ssm` (AmazonSSMManagedInstanceCore) and the tag `Patch Group = lab-soa-02-systems-manager-web`
- The patch baseline `lab-soa-02-systems-manager-al2023` (security updates rated Critical or Important) for that patch group, a State Manager association that scans both instances against it daily (`lab-soa-02-systems-manager-patch-scan`), and one that gathers their software inventory every 30 minutes (`lab-soa-02-systems-manager-inventory`)
- AWS Config: the recorder `lab-soa-02-systems-manager-recorder` (security groups and instances only), its delivery channel to the bucket `cloudlabs-a02…-config`, and the rule `lab-soa-02-systems-manager-restricted-ssh` (the managed rule restricted-ssh, limited to this lab's security groups), which remediates automatically with the Automation document `AWS-DisablePublicAccessForSecurityGroup` under the role `lab-soa-02-systems-manager-remediation`
- `sg-demo` (`lab-demo`), an empty security group attached to nothing, for trying the remediation
- An EC2 Instance Connect Endpoint, `eice-lab`, if you want SSH as well

Sign in as `labadmin`; the password is behind **Show**. Session Manager needs no password: Systems Manager, Session Manager, Start session. AWS allows one Config recorder per region in an account: if the account already records Config in London, this lab cannot deploy until that recorder is turned off.

```text
lab-soa-02-systems-manager (London)
  vpc-lab (slot /20)
    snet-private-1: vm-web1 --+--> vpce-ssm, vpce-ssmmessages, vpce-ec2messages --> Systems Manager
    snet-private-2: vm-web2 --+    (Run Command, Session Manager, patch scan, inventory)
    vpce-s3 (packages and patches)
    sg-demo (empty) <-- watched by Config rule restricted-ssh --> remediation: remove 0.0.0.0/0 on 22
  Config recorder (security groups, instances) --> bucket cloudlabs-<prefix>-config
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- Run Command: Systems Manager, Run Command, `AWS-RunShellScript`, target the tag `Patch Group` = `lab-soa-02-systems-manager-web`, command `uptime; dnf check-update --security | tail -n 5`. Read each instance's output in the console; Run Command itself is free.
- Open a shell on `vm-web1` with Session Manager (no SSH, no key, no open port), then compare it with the Instance Connect Endpoint and with `aws ssm start-session --target <instance id>` from the Connect lines.
- After the patch scan association has run (a few minutes after deploy), open Patch Manager and the Compliance page: which updates are missing, and which baseline decided that? Then run Patch now with Install on `vm-web2` only and compare the two instances.
- On `sg-demo`, add an inbound rule allowing TCP 22 from `0.0.0.0/0`. Within a few minutes Config marks `lab-soa-02-systems-manager-restricted-ssh` non-compliant and the automatic remediation removes the rule; follow it in Config's rule page and in Systems Manager, Automation, Executions. Each recorded change costs about 0.2p and each rule evaluation about 0.08p.
- Open Fleet Manager or Inventory and list the packages the inventory association collected; then on State Manager choose `lab-soa-02-systems-manager-inventory`, Apply association now, and read its execution history.

## Learn more

- [AWS Systems Manager Run Command](https://docs.aws.amazon.com/systems-manager/latest/userguide/run-command.html)
- [AWS Systems Manager Session Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager.html)
- [AWS Systems Manager Patch Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/patch-manager.html)
- [AWS Systems Manager State Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-state.html)
- [Improve the security of EC2 instances by using VPC endpoints for Systems Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/setup-create-vpc.html)
- [restricted-ssh (AWS Config managed rule)](https://docs.aws.amazon.com/config/latest/developerguide/restricted-ssh.html)
- [Remediating noncompliant resources with AWS Config](https://docs.aws.amazon.com/config/latest/developerguide/remediation.html)

Everything this lab builds carries the tag `cloudlabs-lab = soa-02-systems-manager` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
