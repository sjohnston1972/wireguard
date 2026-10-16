Containers on AWS without a server to manage: an ECS cluster running two nginx tasks on Fargate behind an internet-facing Application Load Balancer, with Container Insights watching them, and an ECR repository ready for an image of your own. The tasks live in private subnets and reach out through a NAT gateway. Everything is listed in the lab's resource group, `lab-soa-10-containers`, in AWS Resource Groups (London).
From the SOA-C03 outline: deploy and manage containers with Amazon ECS on AWS Fargate and images in Amazon ECR, and monitor them with CloudWatch Container Insights.

## What it deploys

- The VPC `vpc-lab` (the slot's first /20): two private subnets for the tasks, two public subnets (`snet-public-1/2`) for the load balancer and the NAT gateway, the internet gateway `igw-lab`, and `nat-lab` with its Elastic IP, the private subnets' way out
- The repository `lab-soa-10-containers-web` in Amazon ECR: images scanned on push, the five newest kept. It starts empty
- The cluster `lab-soa-10-containers` with Container Insights, and the service `lab-soa-10-containers-web`: two Fargate tasks (ARM64, 0.25 vCPU and 0.5 GB each) running `public.ecr.aws/nginx/nginx:stable-alpine`, logging to `/cloudlabs/soa-10-containers/web`, started with the role `lab-soa-10-containers-exec`
- The load balancer `alb-<name prefix>` (Name `alb-web`): HTTP on port 80 from anywhere, to the tasks' own addresses (target group `tg-web`, target type ip)

Container Insights writes to its own log group, `/aws/ecs/containerinsights/lab-soa-10-containers/performance`, which ECS makes and the tear-down cannot remove (it carries no lab tag); delete it by hand if you like.

The first Connect line asks the load balancer for the page's headers; the `Server: nginx` line comes from one of the two tasks.

```text
lab-soa-10-containers (London)
  you --HTTP 80--> alb-web (snet-public-1/2) --> tg-web (ip) --> 2 Fargate tasks (snet-private-1/2) [sg-tasks]
  tasks --> nat-lab (snet-public-1) --> igw-lab --> ECR Public (nginx image), CloudWatch Logs
  cluster lab-<id> (Container Insights)     ECR lab-<id>-web (empty, scan on push)
  peering (optional, AWS server only) <--> VPN server's VPC <--> WireGuard tunnel <--> you
```

## Things to try

- Stop one task (ECS, the cluster, Tasks, Stop) and watch the service start a new one to get back to two, while `curl` through the load balancer keeps answering. Then set the service's desired count to 3 and back to 2.
- Open CloudWatch, Container Insights, and look at the cluster's and the service's CPU and memory. Load it with `for i in $(seq 2000); do curl -s -o /dev/null http://<alb>/; done` and watch the numbers move.
- Push an image of your own (needs Docker on your PC; the third and fourth Connect lines), see its scan findings in ECR, then create a new revision of the task definition with that image and update the service. Watch the deployment replace the tasks one at a time.
- Read the task's logs in `/cloudlabs/soa-10-containers/web`: one stream per task, nginx's access log lines from the load balancer's health checks every 15 seconds.
- Compare the target group's targets (task IP addresses) with a load balancer in front of instances (soa-03): Fargate tasks register themselves, by address, as they start.

## Not built here

**Amazon EKS.** EKS runs Kubernetes, with pods, deployments and services instead of ECS tasks and services; Fargate can run either. A cluster costs about 7p an hour on its own before any node, so it has its own lab later (SAA-C03's `saa-19-eks`). See [Amazon EKS and Amazon ECS compared](https://docs.aws.amazon.com/decision-guides/latest/containers-on-aws-how-to-choose/choosing-aws-container-service.html).

## Learn more

- [Amazon ECS on AWS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html)
- [Use a load balancer to distribute Amazon ECS service traffic](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-load-balancing.html)
- [Amazon ECS task execution IAM role](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_execution_IAM_role.html)
- [Monitor Amazon ECS containers using Container Insights](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/cloudwatch-container-insights.html)
- [Pushing a Docker image to an Amazon ECR private repository](https://docs.aws.amazon.com/AmazonECR/latest/userguide/docker-push-ecr-image.html)
- [NAT gateways](https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html)

Everything this lab builds carries the tag `cloudlabs-lab = soa-10-containers` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
