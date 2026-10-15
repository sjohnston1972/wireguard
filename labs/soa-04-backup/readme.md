Backups three ways: an AWS Backup plan and vault that back up an EBS data volume, a snapshot of that volume to restore from, and S3 versioning with a lifecycle rule and replication of every version to a second bucket. Everything is listed in the lab's resource group, `lab-soa-04-backup`, in AWS Resource Groups (London).
From the SOA-C03 outline: implement backup and restore with AWS Backup, EBS snapshots and S3 versioning, lifecycle and replication; from SAA-C03: design resilient storage.

## What it deploys

- A VPC, `vpc-lab` (the first /20 of the session's address slot), with two private subnets and an S3 gateway endpoint
- `vm-data`, a t4g.nano Amazon Linux 2023 instance with no public IP, and its data volume, 1 GiB gp3, attached as `/dev/sdf` and mounted at `/data`, with a file written at deploy (`/data/first-write.txt`)
- `snap-data`, a snapshot of the data volume taken at deploy
- The backup vault `lab-soa-04-backup-vault`, the plan `lab-soa-04-backup-daily` (daily at 05:00 UTC, recovery points kept one day and tagged for the lab) and the selection `lab-soa-04-backup-data`, which backs up the data volume (chosen by its ARN, and only while it carries this lab's tag) with the role `lab-soa-04-backup-backup`
- Two private buckets, `cloudlabs-a04…-src` and `cloudlabs-a04…-dst`, both versioned; the source has the lifecycle rule `tidy` (current objects to Standard-IA after 30 days, old versions removed after 30 days) and replicates every object and delete marker to the destination with the role `lab-soa-04-backup-replication`. `hello.txt` is the first object
- An EC2 Instance Connect Endpoint, `eice-lab`, for SSH from the console

Sign in as `labadmin`; the password is behind **Show**. Restores and copies you make by hand are yours to tag: give them `cloudlabs-lab = soa-04-backup` (the console asks for tags when you restore) so tear-down removes them too.

```text
lab-soa-04-backup (London)
  vpc-lab (slot /20)
    snet-private-1: vm-data (t4g.nano) + data volume (1 GiB, /data) --> snap-data
                    eice-lab (console SSH), vpce-s3
  AWS Backup: plan lab-<id>-daily --> selection lab-<id>-data (the data volume) --> vault lab-<id>-vault
  S3: cloudlabs-<prefix>-src (versioned, lifecycle tidy) --replication--> cloudlabs-<prefix>-dst (versioned)
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- In AWS Backup start an on-demand backup of the 1 GiB data volume (attached to `vm-data` as `/dev/sdf`) into `lab-soa-04-backup-vault` and wait for it to complete; choose the IAM role `lab-soa-04-backup-backup`, not the console's default role. Then restore it to a new volume, again with that role (add the tag `cloudlabs-lab = soa-04-backup`), attach it to `vm-data` as `/dev/sdg`, mount it read-only and compare `first-write.txt`. Restores are charged by the GB; this one is 1 GiB.
- Create a volume from `snap-data` in the same zone (tagged for the lab), attach and mount it, and see what was on the disk at deploy compared with what you have written since.
- Upload a new `hello.txt` to the source bucket twice, then list its versions (the third Connect line) and restore an old version by copying it over the current one. Check that each version also appears in the destination bucket, with its replication status.
- Delete `hello.txt` in the source bucket: a delete marker is added, and it replicates too. Remove the delete marker and the object is back. Then read the lifecycle rule and work out when a current object would move to Standard-IA.
- Change the backup plan's lifecycle or schedule, or add a second rule, and see how the next backup job follows it. Tear-down removes every recovery point in the vault first, so the vault can go.

## Learn more

- [What is AWS Backup?](https://docs.aws.amazon.com/aws-backup/latest/devguide/whatisbackup.html)
- [Assigning resources to a backup plan](https://docs.aws.amazon.com/aws-backup/latest/devguide/assigning-resources.html)
- [Amazon EBS snapshots](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-snapshots.html)
- [Retaining multiple versions of objects with S3 Versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html)
- [Managing the lifecycle of objects](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html)
- [Replicating objects within and across Regions](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication.html)

Everything this lab builds carries the tag `cloudlabs-lab = soa-04-backup` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
