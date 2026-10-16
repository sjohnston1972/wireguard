The classic three-tier web application, built the way SAA-C03 expects: a load balancer in public subnets, an app tier of instances in an Auto Scaling group in private subnets, and a data tier of a Multi-AZ MySQL database and a Valkey cache in subnets of their own, each tier across two Availability Zones and each admitting only the tier in front of it. Everything is listed in the lab's resource group, `lab-saa-11-three-tier`, in AWS Resource Groups (London).
From the SAA-C03 outline: design scalable, loosely coupled and highly available architectures, and choose caching and database options for performance.

## What it deploys

- The VPC `vpc-lab` (the slot's first /20) with three pairs of subnets across two zones: public (`snet-public-1/2`) for the load balancer and the NAT gateway `nat-lab`, private (`snet-private-1/2`) for the app tier, and data (`snet-data-1/2`, route table `rt-data` with no way out) for the database and cache
- The load balancer `alb-<name prefix>` (Name `alb-web`): HTTP on port 80 from anywhere, to the app tier
- The app tier: the Auto Scaling group `asg-<name prefix>`, two (up to four) t4g.micro instances `vm-app` that serve a page naming themselves, their zone, the database and the cache
- The database `db-<name prefix>` (Name `db-app`): RDS for MySQL 8.4, db.t4g.micro, Multi-AZ (a standby in the other zone), private, database `appdb`, user `labadmin` with the session's password
- The cache `c<name prefix>` (Name `cache-app`): one ElastiCache for Valkey node, cache.t4g.micro, encrypted at rest
- Security groups that chain the tiers: `sg-alb` to `sg-vms` on port 80, `sg-vms` to `sg-db` on 3306 and to `sg-cache` on 6379

It takes about 20 minutes: the Multi-AZ database is the slow part, and the app tier starts after it so its page can name it.

```text
lab-saa-11-three-tier (London)
  you --HTTP 80--> alb-web (snet-public-1/2) --> asg vm-app x2 (snet-private-1/2) [sg-vms]
  vm-app --3306--> db-app (MySQL Multi-AZ, snet-data-1/2) [sg-db]
  vm-app --6379--> cache-app (Valkey, snet-data-1/2) [sg-cache]
  vm-app --> nat-lab (snet-public-1) --> igw-lab --> packages and updates
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- Load the page a few times with `curl` (the first Connect line) and watch the instance and zone change: the load balancer spreads requests across both zones.
- Connect to an app instance (the third Connect line), run the `mysql` line with the session password, create a table and add a row. Then reboot the database with failover (RDS, the database, Actions, Reboot, "Reboot with failover") and time how long the client cannot write.
- On the same instance run the `valkey-cli` line (or `redis6-cli` if that is the client that installed), then `SET greeting hello EX 60` and `GET greeting`. To see the speed difference, run `valkey-cli -h <cache address> --latency` (Ctrl+C after a few seconds) and compare it with `time mysql --ssl -h <database address> -u labadmin -p appdb -e 'SELECT 1'`: a cache answers in well under a millisecond, which is why an app would ask it before the database.
- Terminate one app instance and watch the group replace it in the same zone while the page keeps answering from the other.
- Try to reach the database from your PC without peering: there is no route and no public address. The data tier's route table `rt-data` has no way to the internet at all.

## Learn more

- [Multi-AZ DB instance deployments](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZSingleStandby.html)
- [What is Amazon ElastiCache?](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/WhatIs.html)
- [Use Elastic Load Balancing to distribute traffic across the instances in your Auto Scaling group](https://docs.aws.amazon.com/autoscaling/ec2/userguide/autoscaling-load-balancer.html)
- [NAT gateways](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html)
- [Reliability pillar: AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html)

Everything this lab builds carries the tag `cloudlabs-lab = saa-11-three-tier` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
