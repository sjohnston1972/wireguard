Kubernetes on AWS: an EKS cluster whose control plane AWS runs, and one Graviton node in a managed node group, in private subnets that reach the internet through a NAT gateway. Nobody can use the cluster until they are given an access entry, so the first thing you do is give yourself one; then you deploy a sample app with `kubectl` from CloudShell and reach it by port-forward. Everything is listed in the lab's resource group, `lab-saa-19-eks`, in AWS Resource Groups (London).
From the SAA-C03 outline: choose and design container platforms for high-performing architectures, including Amazon EKS with managed node groups.

## What it deploys

- The VPC `vpc-lab` (the slot's first /20): two private subnets for the cluster and its node, two public subnets for the NAT gateway `nat-lab`, the internet gateway `igw-lab`
- The cluster `lab-saa-19-eks` (Name `eks-lab`): standard support, its API reachable privately and, signed with IAM, from CloudShell; access by access entries only (no `aws-auth` ConfigMap), and no entry for anyone yet; the role `lab-saa-19-eks-cluster`, which may not make load balancers
- The node group `lab-saa-19-eks-ng` (Name `ng-lab`): one `t4g.medium` (Graviton, 4 GiB, up to two), Amazon Linux 2023 for EKS, launched from `lt-<name prefix>` (IMDSv2), as the role `lab-saa-19-eks-node`

It takes about 20 minutes: the cluster about 10, the node group about 5 more.

```text
lab-saa-19-eks (London)
  you (CloudShell) --kubectl, signed with IAM--> eks-lab API (public and private endpoints)
  eks-lab control plane (AWS) <--> ng-lab: 1 x t4g.medium (snet-private-1/2) [pods: web x2]
  ng-lab --> nat-lab (snet-public-1) --> igw-lab --> ECR Public (nginx image), EKS
  kubectl port-forward deployment/web 8080:80 --> a web pod (no load balancer)
```

## Things to try

- Open CloudShell and run the first Connect line: it finds your own IAM role (or user), creates an access entry for it and gives it cluster admin. Then open the cluster's Access tab in the EKS console and see the entry. Access entries replace the old `aws-auth` ConfigMap: who may use the cluster is now an AWS API, kept with the cluster. If you sign in to AWS as the root user, use an IAM role or user instead: root cannot be given an entry.
- Run the second line, then `kubectl get nodes -o wide` and `kubectl get pods -A`: the node, and the system pods EKS installed (CoreDNS, kube-proxy, the VPC CNI).
- Deploy the sample with the third line and reach it with the fourth: `kubectl port-forward` carries the traffic through the cluster's API, so no load balancer is needed. `kubectl get pods -o wide` shows each pod has an address from the lab's subnet (the VPC CNI).
- Try `kubectl expose deployment web --type=LoadBalancer --port=80` and watch `kubectl get svc`: the external address stays pending, because the cluster's role is not allowed to make a load balancer (`kubectl describe svc web` shows why). Delete the service again.
- Scale the deployment to 20 (`kubectl scale deployment web --replicas=20`): some pods stay Pending, because one t4g.medium has room for only so many pods. Then raise the node group to 2 in the console and watch them schedule.

## Learn more

- [What is Amazon EKS?](https://docs.aws.amazon.com/eks/latest/userguide/what-is-eks.html)
- [Simplify node lifecycle with managed node groups](https://docs.aws.amazon.com/eks/latest/userguide/managed-node-groups.html)
- [Grant IAM users access to Kubernetes with EKS access entries](https://docs.aws.amazon.com/eks/latest/userguide/access-entries.html)
- [Connect kubectl to an EKS cluster by creating a kubeconfig file](https://docs.aws.amazon.com/eks/latest/userguide/create-kubeconfig.html)
- [View Kubernetes resources in the AWS Management Console](https://docs.aws.amazon.com/eks/latest/userguide/view-kubernetes-resources.html)

Everything this lab builds carries the tag `cloudlabs-lab = saa-19-eks` and is removed at tear-down. Anything you create by hand is removed only if you give it that tag; untagged things you leave inside the lab's VPCs are named as leftovers so you can delete them.
