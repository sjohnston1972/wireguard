Block, file and object storage side by side, and what each costs. One instance has a gp3 and an io2 EBS volume and an EFS file system mounted; a bucket next to it moves objects between storage classes by itself. Measure the volumes, share files through EFS, and see which S3 class each object lands in. Everything is listed in the lab's resource group, `lab-saa-14-storage`, in AWS Resource Groups (London).
From the SAA-C03 outline: choose high-performing storage for block, file and object needs, and cost-optimised storage classes and lifecycle rules.

## What it deploys

- The VPC `vpc-lab` (the slot's first /20), two private subnets, an S3 gateway endpoint and an Instance Connect Endpoint (the template)
- The instance `vm-storage` (t4g.micro, Amazon Linux 2023) with two extra volumes: a 4 GiB **gp3** at `/dev/sdf` (3,000 IOPS whatever its size) and a 4 GiB **io2** with 100 provisioned IOPS at `/dev/sdg`, both unformatted; on Nitro instances they appear as `/dev/nvme1n1` and `/dev/nvme2n1` (`lsblk` shows which)
- The file system `efs-shared` (EFS Standard, encrypted, bursting throughput) with a mount target in each private subnet, mounted on the instance at `/mnt/efs`
- The bucket `cloudlabs-<name prefix>-tiers`: `reports/` to S3 Intelligent-Tiering at once (archive tiers after 90 and 180 days unread); `logs/` to Standard-IA after 30 days, Glacier Instant Retrieval after 90, deleted after a year; two sample objects

```text
lab-saa-14-storage (London)
  vm-storage (snet-private-1) -- root gp3 8 GiB, gp3 4 GiB /dev/sdf, io2 4 GiB 100 IOPS /dev/sdg
  vm-storage --NFS 2049--> efs-shared mount targets (snet-private-1/2) [sg-efs]
  vm-storage --S3 endpoint--> cloudlabs-<prefix>-tiers (Intelligent-Tiering, lifecycle)
```

## Things to try

- Connect (the first Connect line), run `lsblk` to find the two data volumes, then the second line against each (change the device): the gp3 reads at about 3,000 IOPS, the io2 at about its 100. Then think about what each costs per month: the io2's IOPS are billed whether you use them or not.
- Write a file to `/mnt/efs`, then open a second Instance Connect session and read it: EFS is shared, an EBS volume can only be attached to one instance (in its own zone).
- List the bucket with the fourth line: the report is already `INTELLIGENT_TIERING`; the log starts as `STANDARD` and the lifecycle rule moves it later. Upload a file to `reports/` and one to the top of the bucket with `aws s3 cp` and see where each lands.
- Format and mount the gp3 volume (`sudo mkfs -t xfs /dev/nvme1n1 && sudo mkdir /data && sudo mount /dev/nvme1n1 /data`), then grow it to 8 GiB in the EC2 console while mounted and extend the file system with `sudo xfs_growfs /data`: no downtime.
- In the EFS console, set the file system's lifecycle to move files to Infrequent Access after 7 days unread, and compare the two storage classes' prices.
- Compare prices for 100 GiB a month in London from the AWS pricing pages: S3 Standard, S3 Standard-IA, Glacier Instant Retrieval, EFS Standard, EFS Infrequent Access, gp3 and io2.

## Learn more

- [How S3 Intelligent-Tiering works](https://docs.aws.amazon.com/AmazonS3/latest/userguide/intelligent-tiering.html)
- [Managing the lifecycle of objects](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html)
- [What is Amazon Elastic File System?](https://docs.aws.amazon.com/efs/latest/ug/whatisefs.html)
- [Amazon EBS volume types](https://docs.aws.amazon.com/ebs/latest/userguide/ebs-volume-types.html)
- [Mounting EFS file systems using the EFS mount helper](https://docs.aws.amazon.com/efs/latest/ug/mounting-fs-mount-helper-ec2-linux.html)

Everything this lab builds carries the tag `cloudlabs-lab = saa-14-storage` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
