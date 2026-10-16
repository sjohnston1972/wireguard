# eks.tf
#
# Plain English: lab 19's Kubernetes (ruling P7). The cluster lab-<id> on
# standard support (never extended, which bills six times as much), in the two
# private subnets, its API reachable privately and (IAM-authenticated) from
# the internet so CloudShell can use it. Access is by access entries only:
# nobody, not even the pipeline that made it, is a Kubernetes admin until you
# give yourself an entry (the first Connect line). No control-plane logs (they
# would make a log group outside /cloudlabs/). The cluster role is denied
# making load balancers and security groups, so a Kubernetes LoadBalancer
# service can never leave an untagged load balancer behind (ruling P8): reach
# the sample app by port-forward. One t4g.medium node (at most two) in a
# managed node group, launched from a template that tags instance, volume and
# interface at launch and requires IMDSv2 (hop limit 2, EKS's default, so pods
# can still reach it: what they get is the node role, inside the lab
# boundary). The node role's
# three AWS managed policies are attached one by one, each named in full, so
# the scope check can read every one (pre-flight C3).

locals {
  cluster_name = "lab-${var.lab_id}"
}

resource "aws_iam_role" "cluster" {
  name                 = "lab-${var.lab_id}-cluster"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "eks.amazonaws.com" }, Action = ["sts:AssumeRole", "sts:TagSession"] }]
  })
}

resource "aws_iam_role_policy_attachment" "cluster" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

resource "aws_iam_policy" "no_load_balancers" {
  name = "lab-${var.lab_id}-no-lb"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Sid = "NoLoadBalancerServices", Effect = "Deny", Action = ["elasticloadbalancing:CreateLoadBalancer", "ec2:CreateSecurityGroup"], Resource = "*" }]
  })
}

resource "aws_iam_role_policy_attachment" "cluster_no_lb" {
  role       = aws_iam_role.cluster.name
  policy_arn = aws_iam_policy.no_load_balancers.arn
}

resource "aws_iam_role" "node" {
  name                 = "lab-${var.lab_id}-node"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "node_worker" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
}

resource "aws_iam_role_policy_attachment" "node_cni" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
}

resource "aws_iam_role_policy_attachment" "node_ecr" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_eks_cluster" "lab" {
  name                          = local.cluster_name
  role_arn                      = aws_iam_role.cluster.arn
  bootstrap_self_managed_addons = true

  vpc_config {
    subnet_ids              = aws_subnet.private[*].id
    endpoint_private_access = true
    endpoint_public_access  = true
  }
  access_config {
    authentication_mode                         = "API"
    bootstrap_cluster_creator_admin_permissions = false
  }
  upgrade_policy {
    support_type = "STANDARD"
  }
  tags       = { Name = "eks-lab" }
  depends_on = [aws_iam_role_policy_attachment.cluster, aws_iam_role_policy_attachment.cluster_no_lb, aws_route.private_nat]
}

resource "aws_launch_template" "node" {
  name                   = "lt-${var.name_prefix}"
  update_default_version = true

  metadata_options {
    http_tokens                 = "required"
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 2
  }
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 20
      volume_type           = "gp3"
      delete_on_termination = true
    }
  }
  tag_specifications {
    resource_type = "instance"
    tags          = merge(var.tags, { Name = "node-eks" })
  }
  tag_specifications {
    resource_type = "volume"
    tags          = merge(var.tags, { Name = "node-eks" })
  }
  tag_specifications {
    resource_type = "network-interface"
    tags          = merge(var.tags, { Name = "node-eks" })
  }
  tags = { Name = "lt-node" }
}

resource "aws_eks_node_group" "lab" {
  cluster_name    = aws_eks_cluster.lab.name
  node_group_name = "lab-${var.lab_id}-ng"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = aws_subnet.private[*].id
  ami_type        = "AL2023_ARM_64_STANDARD"
  instance_types  = ["t4g.medium"]
  capacity_type   = "ON_DEMAND"

  scaling_config {
    desired_size = 1
    min_size     = 1
    max_size     = 2
  }
  update_config {
    max_unavailable = 1
  }
  launch_template {
    id      = aws_launch_template.node.id
    version = aws_launch_template.node.latest_version
  }
  tags       = { Name = "ng-lab" }
  depends_on = [aws_iam_role_policy_attachment.node_worker, aws_iam_role_policy_attachment.node_cni, aws_iam_role_policy_attachment.node_ecr]
}
