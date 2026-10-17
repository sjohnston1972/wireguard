# lattice.tf
#
# Plain English: lab 30's VPC Lattice (ruling P19). One service network,
# lab-<id>-sn, that requires signed requests (AWS_IAM), and two HTTP
# services on it: svc-a, whose target is vm-svc-a in vpc-lab, and svc-b,
# whose target is vm-svc-b in vpc-svc-b. Each service has a listener on port
# 80 forwarding to a target group of one instance, health-checked on "/".
# vpc-lab is associated with the network through the security group
# sg-lattice (HTTP in from vpc-lab), so its instances can call both services;
# vpc-svc-b is not associated: it only hosts a target.
#
# Who may call what: the network's auth policy lets only the lab's client
# role invoke anything on it; svc-a's lets that role make GET requests;
# svc-b has no auth policy, and a service that requires signing with no
# policy refuses everyone (a Thing to try). Both policies are known at plan
# and name the role by its ARN, built from the account and the role's own
# fixed path and name (rulings P7, P19). Targets are registered and policies
# put 20 seconds after their target groups, services and network are made
# (ruling P21: Lattice's tags are not yet proven to be readable at once).

locals {
  client_role_arn = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/cloudlabs-lab/lab-${var.lab_id}-client"
}

data "aws_ec2_managed_prefix_list" "lattice" {
  name = "com.amazonaws.${var.region}.vpc-lattice"
}

resource "aws_security_group" "lattice" {
  name        = "lab-lattice"
  description = "Association of vpc-lab with the service network: HTTP from vpc-lab"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-lattice" }
}

resource "aws_vpc_security_group_ingress_rule" "lattice_http" {
  security_group_id = aws_security_group.lattice.id
  cidr_ipv4         = local.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpclattice_service_network" "lab" {
  name      = "lab-${var.lab_id}-sn"
  auth_type = "AWS_IAM"
  tags      = { Name = "sn-lab" }
}

resource "aws_vpclattice_service" "a" {
  name      = "lab-${var.lab_id}-svc-a"
  auth_type = "AWS_IAM"
  tags      = { Name = "svc-a" }
}

resource "aws_vpclattice_service" "b" {
  name      = "lab-${var.lab_id}-svc-b"
  auth_type = "AWS_IAM"
  tags      = { Name = "svc-b" }
}

resource "aws_vpclattice_target_group" "a" {
  name = "lab-${var.lab_id}-tg-a"
  type = "INSTANCE"

  config {
    port           = 80
    protocol       = "HTTP"
    vpc_identifier = aws_vpc.lab.id

    health_check {
      enabled  = true
      protocol = "HTTP"
      port     = 80
      path     = "/"
    }
  }
  tags = { Name = "tg-a" }
}

resource "aws_vpclattice_target_group" "b" {
  name = "lab-${var.lab_id}-tg-b"
  type = "INSTANCE"

  config {
    port           = 80
    protocol       = "HTTP"
    vpc_identifier = aws_vpc.svc_b.id

    health_check {
      enabled  = true
      protocol = "HTTP"
      port     = 80
      path     = "/"
    }
  }
  tags = { Name = "tg-b" }
}

# Ruling P21: the first tag-checked change on each new Lattice item waits 20 seconds after its create.
resource "time_sleep" "lattice_tags" {
  create_duration = "20s"
  depends_on = [
    aws_vpclattice_service_network.lab,
    aws_vpclattice_service.a,
    aws_vpclattice_service.b,
    aws_vpclattice_target_group.a,
    aws_vpclattice_target_group.b,
  ]
}

resource "aws_vpclattice_target_group_attachment" "a" {
  target_group_identifier = aws_vpclattice_target_group.a.id

  target {
    id   = aws_instance.svc_a.id
    port = 80
  }
  depends_on = [time_sleep.lattice_tags]
}

resource "aws_vpclattice_target_group_attachment" "b" {
  target_group_identifier = aws_vpclattice_target_group.b.id

  target {
    id   = aws_instance.svc_b.id
    port = 80
  }
  depends_on = [time_sleep.lattice_tags]
}

resource "aws_vpclattice_listener" "a" {
  name               = "http-80"
  protocol           = "HTTP"
  port               = 80
  service_identifier = aws_vpclattice_service.a.id

  default_action {
    forward {
      target_groups {
        target_group_identifier = aws_vpclattice_target_group.a.id
        weight                  = 100
      }
    }
  }
  tags = { Name = "listener-a" }
}

resource "aws_vpclattice_listener" "b" {
  name               = "http-80"
  protocol           = "HTTP"
  port               = 80
  service_identifier = aws_vpclattice_service.b.id

  default_action {
    forward {
      target_groups {
        target_group_identifier = aws_vpclattice_target_group.b.id
        weight                  = 100
      }
    }
  }
  tags = { Name = "listener-b" }
}

resource "aws_vpclattice_service_network_service_association" "a" {
  service_identifier         = aws_vpclattice_service.a.id
  service_network_identifier = aws_vpclattice_service_network.lab.id
  tags                       = { Name = "sn-svc-a" }
}

resource "aws_vpclattice_service_network_service_association" "b" {
  service_identifier         = aws_vpclattice_service.b.id
  service_network_identifier = aws_vpclattice_service_network.lab.id
  tags                       = { Name = "sn-svc-b" }
}

resource "aws_vpclattice_service_network_vpc_association" "lab" {
  vpc_identifier             = aws_vpc.lab.id
  service_network_identifier = aws_vpclattice_service_network.lab.id
  security_group_ids         = [aws_security_group.lattice.id]
  tags                       = { Name = "sn-vpc-lab" }
}

resource "aws_vpclattice_auth_policy" "network" {
  resource_identifier = aws_vpclattice_service_network.lab.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "LabClientOnly"
      Effect    = "Allow"
      Principal = { AWS = local.client_role_arn }
      Action    = "vpc-lattice-svcs:Invoke"
      Resource  = "*"
    }]
  })
  depends_on = [time_sleep.lattice_tags, aws_iam_role.client]
}

resource "aws_vpclattice_auth_policy" "svc_a" {
  resource_identifier = aws_vpclattice_service.a.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "LabClientGetOnly"
      Effect    = "Allow"
      Principal = { AWS = local.client_role_arn }
      Action    = "vpc-lattice-svcs:Invoke"
      Resource  = "*"
      Condition = { StringEquals = { "vpc-lattice-svcs:RequestMethod" = "GET" } }
    }]
  })
  depends_on = [time_sleep.lattice_tags, aws_iam_role.client]
}
