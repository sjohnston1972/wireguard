Pilot-light disaster recovery: the app runs only in London, but everything needed to run it in Ireland is already there. Its data is copied as it is written (S3 cross-region replication and a DynamoDB global table), its image has been copied to Ireland, and a launch template and a fixed standby address wait in an Ireland VPC. A private DNS name points at London while London's health alarm is quiet and at Ireland when it fires. Everything is listed in the lab's resource groups, `lab-saa-16-dr-pilot-light`, in AWS Resource Groups (London and Ireland; the DNS zone and health check are global).
From the SAA-C03 outline: design disaster recovery strategies (backup and restore, pilot light, warm standby) across Regions, meeting recovery time and point objectives.

## What it deploys

- **London**: the VPC `vpc-lab` with the app instance `vm-app` (t4g.nano, a page saying "app in London (primary)") and the alarm `lab-saa-16-dr-pilot-light-app-down` (status checks failing, or no data at all)
- **Ireland**: the VPC `vpc-dr` (the slot's second /20) with the subnet `snet-dr`, an S3 gateway endpoint, an Instance Connect Endpoint `eice-dr`, the security group `sg-dr`, and the launch template `lt-<name prefix>-dr` built on `ami-dr`, the copy of London's Amazon Linux 2023 image. Nothing runs in Ireland
- **Data**: the buckets `cloudlabs-<name prefix>-london` and `-ireland`, versioned, with every object and delete marker replicated London to Ireland by the role `lab-saa-16-dr-pilot-light-replication`; the table `lab-saa-16-dr-pilot-light-orders`, a DynamoDB global table with its replica in Ireland
- **DNS**: the private zone `dr.<name prefix>.internal`, answering in both VPCs; the name `app` in it fails over from London's address to the Ireland standby address when the health check `hc-app` (following the alarm) turns unhealthy

```text
lab-saa-16-dr-pilot-light
  London: vm-app (snet-private-1) --alarm app-down--> hc-app
  app.dr.<prefix>.internal: PRIMARY vm-app (while hc-app healthy), SECONDARY Ireland standby address
  cloudlabs-<prefix>-london --replication--> cloudlabs-<prefix>-ireland
  table-orders (London) <--global table--> replica (Ireland)
  Ireland: vpc-dr, snet-dr, lt-dr on ami-dr (copied from London), nothing running
```

## Things to try

- Connect to `vm-app` (the first Connect line) and resolve the name with the second: London's address. Stop `vm-app` in the EC2 console (from your PC), wait three or four minutes for the alarm to fire and the health check to turn unhealthy, start it again and resolve the name once you are back in: you get Ireland's standby address until London has been healthy again for a few minutes. Watch the alarm and the health check change in their consoles.
- Run the DR drill: launch the DR instance in Ireland with the third Connect line (CloudShell), connect to it through `eice-dr` (`aws ec2-instance-connect ssh --region eu-west-1 --instance-id <id> --os-user labadmin --connection-type eice`), and `curl localhost`. How long did that take? That is the pilot light's recovery time. Terminate it when you are done; if you forget, the tear-down's safety net does it (the destroy then ends with a fallback: the tear-down still finishes clean, reported as "success with fallback").
- Write an order in London and read it in Ireland with the fourth line: a global table replicates within about a second.
- Upload a file to the London bucket with the fifth line: after a short while its replication status is `COMPLETED` and the copy is in the Ireland bucket. Delete it in London and see the delete marker arrive in Ireland too.
- Compare the four DR strategies in the AWS whitepaper below and decide what you would add to turn this pilot light into a warm standby, and what that would cost per hour.

## Learn more

- [Disaster recovery options in the cloud](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-options-in-the-cloud.html)
- [Replicating objects within and across Regions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication.html)
- [Global tables: multi-active, multi-Region replication](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GlobalTables.html)
- [Configuring failover in a private hosted zone](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-failover-private-hosted-zones.html)
- [Copy an Amazon EC2 AMI](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/CopyingAMIs.html)

Everything this lab builds carries the tag `cloudlabs-lab = saa-16-dr-pilot-light` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
