One small Amazon Linux instance that reports more than EC2 does on its own: the CloudWatch agent sends memory and disk use and an application log, a metric filter turns log lines into a metric, and alarms and an EventBridge rule tell an SNS topic when things change. Everything is listed in the lab's resource group, `lab-soa-01-cloudwatch`, in AWS Resource Groups (London).
From the SOA-C03 outline: implement metrics, alarms and filters with Amazon CloudWatch, install and configure the CloudWatch agent, analyse logs with CloudWatch Logs Insights, and use Amazon EventBridge to act on events.

## What it deploys

- A VPC, `vpc-lab` (the first /20 of the session's address slot), with two private subnets and no route to the internet: an S3 gateway endpoint lets the instance install packages, and interface endpoints for CloudWatch Logs and CloudWatch (`vpce-logs`, `vpce-monitoring`) carry the agent's data
- `vm-app`, a t4g.micro Amazon Linux 2023 instance with no public IP, detailed (1-minute) monitoring and the role `lab-soa-01-cloudwatch-vm` (CloudWatchAgentServerPolicy). A small service, `lab-app`, writes a line every 10 seconds to `/var/log/lab-app.log`; every tenth is an `ERROR`
- The CloudWatch agent, sending `mem_used_percent` and the root disk's `used_percent` to the namespace `cloudlabs/soa-01-cloudwatch`, and the app log to the log group `/cloudlabs/soa-01-cloudwatch/app` (kept for one day)
- A metric filter, `lab-errors`, that counts `ERROR` lines as the metric `AppErrors`
- Three alarms, `lab-soa-01-cloudwatch-cpu-high`, `lab-soa-01-cloudwatch-app-errors` and `lab-soa-01-cloudwatch-memory-high`, which notify the SNS topic `lab-soa-01-cloudwatch-alerts` (no subscribers until you add one)
- The dashboard `lab-soa-01-cloudwatch-overview`, the saved Logs Insights query `lab-soa-01-cloudwatch-errors`, and the EventBridge rule `lab-soa-01-cloudwatch-ec2-state`, which sends `vm-app`'s state changes to the same topic
- An EC2 Instance Connect Endpoint, `eice-lab`, for SSH from the console with no public IP

Sign in as `labadmin`; the password is behind **Show**. Connect from the console (EC2, `vm-app`, Connect, EC2 Instance Connect, Connect using EC2 Instance Connect Endpoint) or with the first Connect line. With **Peer to gateway** (only while the VPN server runs in AWS) the ssh line works from a tunnel client.

```text
lab-soa-01-cloudwatch (London)
  vpc-lab (slot /20)
    snet-private-1: vm-app (t4g.micro) + CloudWatch agent --> vpce-logs, vpce-monitoring
                    eice-lab (console SSH)
    vpce-s3 (packages)
  log group /cloudlabs/<id>/app --> metric filter lab-errors --> alarm app-errors --+
  alarms cpu-high and memory-high ------------------------------------------------+--> SNS lab-<id>-alerts
  EventBridge rule ec2-state (vm-app's state changes) ----------------------------+
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- Subscribe your email to `lab-soa-01-cloudwatch-alerts` (SNS, Topics, Create subscription, protocol Email) and confirm it. Then stop and start `vm-app` from the console: the EventBridge rule sends each state change to your inbox.
- Connect to `vm-app` and load its CPU with `yes > /dev/null &` twice (`pkill yes` when you are done). Watch `lab-soa-01-cloudwatch-cpu-high` go to In alarm on the dashboard within about three minutes: detailed monitoring gives 1-minute points, and the alarm wants two.
- In CloudWatch Logs Insights pick the saved query `lab-soa-01-cloudwatch-errors` and run it, then count errors a minute with `stats count(*) by bin(1m)`. Logs Insights charges for the data it scans, about half a penny per GB; this log is tiny.
- Change the metric filter to count only lines containing `timed out`, or lower the `app-errors` alarm's threshold, and see how quickly the alarm follows. Then add an EC2 action that stops the instance to the CPU alarm and watch CloudWatch act on its own.
- Read the agent's configuration in `/opt/aws/amazon-cloudwatch-agent/etc/lab.json`, add `swap_used_percent` to the memory measurements and reload it with `sudo amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/lab.json`. Each custom metric costs about 23p a month while it reports.

## Learn more

- [Collect metrics and logs with the CloudWatch agent](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Install-CloudWatch-Agent.html)
- [Using Amazon CloudWatch alarms](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/AlarmThatSendsEmail.html)
- [Creating metrics from log events using filters](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/MonitoringLogData.html)
- [Analyzing log data with CloudWatch Logs Insights](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/AnalyzingLogData.html)
- [Using Amazon CloudWatch dashboards](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Dashboards.html)
- [Rules in Amazon EventBridge](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rules.html)
- [Connect using EC2 Instance Connect Endpoint](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/connect-with-ec2-instance-connect-endpoint.html)

Everything this lab builds carries the tag `cloudlabs-lab = soa-01-cloudwatch` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
