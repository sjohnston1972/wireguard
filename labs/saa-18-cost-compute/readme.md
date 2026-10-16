The same small web server on two purchase options (On-Demand and Spot), three instance types and two processor families. An Auto Scaling group keeps one On-Demand Graviton instance as its base and runs everything above it on Spot, letting AWS pick among a Graviton and an x86 type by price and spare capacity. Each instance's page says what it is and how it is billed. Everything is listed in the lab's resource group, `lab-saa-18-cost-compute`, in AWS Resource Groups (London).
From the SAA-C03 outline: design cost-optimised compute: choose purchase options (On-Demand, Spot, Savings Plans, Reserved Instances) and instance families, and mix them in an Auto Scaling group.

## What it deploys

- The VPC `vpc-lab` (the slot's first /20), two private subnets, an S3 gateway endpoint and an Instance Connect Endpoint (the template)
- The group `asg-<name prefix>`: three instances (up to four) across both zones; the first an On-Demand `t4g.micro`, the rest Spot from `t4g.micro`, `t4g.small` or `t3.micro` (price-capacity-optimized), replaced early when AWS warns it will reclaim one (capacity rebalancing)
- Two launch templates, `lt-<name prefix>-arm` (Graviton, arm64) and `lt-<name prefix>-x86` (x86_64), Amazon Linux 2023 from AWS's public parameters; each instance serves a page naming its type, purchase option (`spot` or `on-demand`), architecture and zone

Prices in London today, On-Demand, Linux, per hour (check the second Connect line for Spot; it moves):

- `t4g.micro`, Graviton (arm64), 2 vCPU, 1 GiB: On-Demand about $0.0095, Spot typically about a third of that
- `t4g.small`, Graviton (arm64), 2 vCPU, 2 GiB: On-Demand about $0.019, Spot typically about a third of that
- `t3.micro`, Intel (x86_64), 2 vCPU, 1 GiB: On-Demand about $0.012, Spot typically about a third of that

```text
lab-saa-18-cost-compute (London)
  asg-<prefix> (snet-private-1/2): base 1 x On-Demand t4g.micro (lt-arm)
                                   above it: Spot t4g.micro | t4g.small (lt-arm) | t3.micro (lt-x86)
  each instance: page = type, spot/on-demand, aarch64/x86_64, zone
```

## Things to try

- List the instances with the first Connect line (CloudShell): one with `None` in the lifecycle column (On-Demand) and two `spot`. Which Spot types did AWS choose, and in which zones?
- Run the second line and compare today's Spot prices with the prices above: how much would a month of each cost, per instance, On-Demand and Spot?
- Connect to an instance (third line) and run `curl -s localhost`: the page says its type, `spot` or `on-demand`, and `aarch64` or `x86_64`. The same AMI family runs on both architectures; most open-source software does too.
- Raise the group's desired capacity to 4 and watch the new instance come up on Spot. Lower it to 3 and see which one AWS removes.
- In the Auto Scaling console, look at the group's Activity history: a Spot instance AWS reclaims (rare in a short session) is replaced automatically, and the On-Demand base is never reclaimed.

## Not built here

**Savings Plans and Reserved Instances.** Both are billing commitments, not resources: you agree to pay for a level of use (Savings Plans: dollars an hour of compute; Reserved Instances: an instance type in a Region) for one or three years, and AWS discounts the On-Demand price, by up to about 72%. A lab cannot buy one for a two-hour session; compare them with Spot (no commitment, can be reclaimed) in the AWS pages below.

## Learn more

- [Auto Scaling groups with multiple instance types and purchase options](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-mixed-instances-groups.html)
- [Spot Instances](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-spot-instances.html)
- [Use Capacity Rebalancing to handle Amazon EC2 Spot Interruptions](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-capacity-rebalancing.html)
- [What are Savings Plans?](https://docs.aws.amazon.com/savingsplans/latest/userguide/what-is-savings-plans.html)
- [Reserved Instances for Amazon EC2](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-reserved-instances.html)

Everything this lab builds carries the tag `cloudlabs-lab = saa-18-cost-compute` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
