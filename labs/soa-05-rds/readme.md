A Multi-AZ RDS for MySQL database with a read replica and a client instance to drive it: force a failover and time it, read from the replica and watch its lag, take a snapshot, and find slow queries with the slow query log. Everything is listed in the lab's resource group, `lab-soa-05-rds`, in AWS Resource Groups (London).
From the SOA-C03 outline: implement high availability with Amazon RDS Multi-AZ, scale reads with read replicas, back up and restore with snapshots, and monitor database performance; from SAA-C03: design high-performing database solutions.

## What it deploys

- A VPC, `vpc-lab` (the first /20 of the session's address slot), with two private subnets in two Availability Zones, and an S3 gateway endpoint for packages
- `db-a05…` (shown as `db-primary`), RDS for MySQL 8.4 on db.t4g.micro, Multi-AZ, 20 GiB of General Purpose storage, encrypted, not public, in the subnet group `lab-soa-05-rds-db`, with automated backups kept for a day
- `db-a05…-replica` (shown as `db-replica`), a single-AZ read replica of it
- The parameter group `lab-soa-05-rds-mysql84`: the slow query log on, for statements over one second
- `vm-client`, a t4g.nano Amazon Linux 2023 instance with no public IP and the MySQL client; its `~/.my.cnf` points `mysql` at the primary and `mysql --defaults-group-suffix=-replica` at the replica
- The security group `lab-db` (MySQL on 3306 from the lab instances and, when peered, the VPN server's VPC) and an EC2 Instance Connect Endpoint, `eice-lab`

The database user is `labadmin` with the session password (behind **Show**). Performance Insights is not offered for MySQL on db.t4g.micro, so use CloudWatch Database Insights in its free standard mode and the RDS metrics instead. Deploying takes about 30 minutes and tear-down about 20: the Multi-AZ database and then the replica are created (and deleted) one after the other. The `mysql` client connects over TLS.

```text
lab-soa-05-rds (London)
  vpc-lab (slot /20)
    snet-private-1 (zone a): vm-client (mysql) ---3306---> db-primary (Multi-AZ, primary)
                             eice-lab (console SSH)          |  synchronous standby in zone b
    snet-private-2 (zone b): standby                         |  asynchronous replication
                             db-replica (read replica) <-----+
    vpce-s3 (packages)
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- On `vm-client`, create a table and add rows (`mysql -e "CREATE TABLE t (id INT PRIMARY KEY AUTO_INCREMENT, at DATETIME); INSERT INTO t (at) VALUES (NOW());"`), then read them back from the replica with `mysql --defaults-group-suffix=-replica -e "SELECT COUNT(*) FROM t"` and check `Seconds_Behind_Source` in `SHOW REPLICA STATUS`.
- Force a failover: `aws rds reboot-db-instance --db-instance-identifier <the primary's identifier> --force-failover`, or Reboot with failover in the console. Run `dig +short <the primary's endpoint>` and a loop of `mysql -e "SELECT NOW()"` on `vm-client` to see the address change and how long writes stop.
- Run `mysql -e "SELECT SLEEP(2)"` a few times, then read the slow query log in the console (the database, Logs and events). Change `long_query_time` in `lab-soa-05-rds-mysql84` and see it apply without a reboot.
- Take a manual snapshot of the primary. Because the database copies its tags to snapshots, the snapshot carries `cloudlabs-lab = soa-05-rds` and tear-down removes it; a snapshot restored to a new database is yours to tag the same way.
- Open the database's Monitoring tab and CloudWatch Database Insights (standard mode): compare CPU, connections and replica lag on the primary and the replica while you run the inserts above in a loop.

## Learn more

- [Multi-AZ DB instance deployments for Amazon RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZSingleStandby.html)
- [Working with DB instance read replicas](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.html)
- [Parameter groups for Amazon RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithParamGroups.html)
- [Creating a DB snapshot for a Single-AZ DB instance](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_CreateSnapshot.html)
- [Rebooting a DB instance](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_RebootInstance.html)
- [Monitoring Amazon RDS with CloudWatch Database Insights](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Database-Insights.html)

Everything this lab builds carries the tag `cloudlabs-lab = soa-05-rds` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
