An Auto Scaling group of two to four small instances across two Availability Zones behind an internet-facing Application Load Balancer, so you can watch AWS keep a service running: it replaces unhealthy instances, scales on CPU, follows a schedule, holds new instances at a lifecycle hook and rolls out a new launch template. Everything is listed in the lab's resource group, `lab-soa-03-auto-scaling`, in AWS Resource Groups (London).
From the SOA-C03 outline: implement scaling and load balancing with Amazon EC2 Auto Scaling and Elastic Load Balancing, and deploy with launch templates and instance refresh; from SAA-C03: design highly available architectures across Availability Zones.

## What it deploys

- A VPC, `vpc-lab` (the first /20 of the session's address slot), with two private subnets for the instances and two public subnets for the load balancer, an internet gateway, and an S3 gateway endpoint for packages
- The launch template `lt-a03…`: Amazon Linux 2023 on t4g.micro, IMDSv2, no public IP, and a small service that serves a page with the instance's id and Availability Zone on port 80
- The Auto Scaling group `asg-a03…`: at least 2 and at most 4 instances named `vm-web` across both private subnets, with ELB health checks (a failed check replaces the instance), a target tracking policy at 50% average CPU, the scheduled action `evening-back-to-two` (22:00 London time), the lifecycle hook `launch-wait` (60 seconds) and rolling instance refresh
- The internet-facing Application Load Balancer `alb-a03…` (Name tag `alb-web`; HTTP on port 80 from anywhere), its target group `tg-a03…` and listener; the instances admit port 80 only from the load balancer
- An EC2 Instance Connect Endpoint, `eice-lab`, for SSH to an instance from the console

Sign in as `labadmin`; the password is behind **Show**. Open the first Connect line's address in a browser and refresh: the instance and zone change as the load balancer spreads requests.

```text
lab-soa-03-auto-scaling (London)
  internet --> alb-<prefix> (snet-public-1, snet-public-2) : HTTP 80
                 |  target group tg-<prefix>, health check /
  vpc-lab (slot /20)
    snet-private-1 (zone a): vm-web ... --+-- Auto Scaling group asg-<prefix> (2 to 4)
    snet-private-2 (zone b): vm-web ... --+   target tracking 50% CPU, schedule, lifecycle hook
    eice-lab (console SSH), vpce-s3 (packages)
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- Terminate one instance from the EC2 console and watch the group notice, launch a replacement, hold it at `launch-wait` (Pending:Wait) for 60 seconds, and add it back to the target group. With `aws autoscaling complete-lifecycle-action` you can release it sooner.
- Connect to both instances and run `yes > /dev/null &` on each: within about 10 minutes (basic 5-minute metrics) target tracking adds instances, up to four, and removes them once you `pkill yes`. Follow it in the group's Activity tab.
- Change the launch template (a new version with another `Description=` line in the service, or another instance size from the allowed t4g ones), then start an instance refresh and watch the rolling replacement keep at least half the group healthy.
- Edit the scheduled action to run five minutes from now with a desired capacity of 3 and watch it happen; then set it back.
- Stop the web service on one instance (`sudo systemctl stop lab-web`) and watch the target group mark it unhealthy and the group replace it. The load balancer bills its capacity units for traffic; light testing costs pennies.

## Learn more

- [Target tracking scaling policies for Amazon EC2 Auto Scaling](https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-scaling-target-tracking.html)
- [Scheduled scaling for Amazon EC2 Auto Scaling](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-scheduled-scaling.html)
- [Amazon EC2 Auto Scaling lifecycle hooks](https://docs.aws.amazon.com/autoscaling/ec2/userguide/lifecycle-hooks.html)
- [Use an instance refresh to update instances in an Auto Scaling group](https://docs.aws.amazon.com/autoscaling/ec2/userguide/asg-instance-refresh.html)
- [Health checks for instances in an Auto Scaling group](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-health-checks.html)
- [What is an Application Load Balancer?](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/introduction.html)

Everything this lab builds carries the tag `cloudlabs-lab = soa-03-auto-scaling` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
