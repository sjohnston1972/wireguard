# ssm.tf
#
# Plain English: lab 02's two instances, managed by Systems Manager with no
# SSH or internet: their role (AmazonSSMManagedInstanceCore), interface
# endpoints for ssm, ssmmessages and ec2messages, a patch baseline for
# Amazon Linux 2023 and its patch group (the instances' "Patch Group" tag),
# and two State Manager associations: a daily patch scan and a software
# inventory every 30 minutes.

resource "aws_iam_role" "ssm" {
  name                 = "lab-${var.lab_id}-ssm"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.ssm.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "ssm" {
  name = "lab-${var.lab_id}-ssm"
  path = "/cloudlabs-lab/"
  role = aws_iam_role.ssm.name
}

resource "aws_security_group" "endpoints" {
  name        = "lab-endpoints"
  description = "Interface endpoints: HTTPS from the lab VPC"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-endpoints" }
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_https" {
  security_group_id = aws_security_group.endpoints.id
  cidr_ipv4         = local.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = toset(["ssm", "ssmmessages", "ec2messages"])
  vpc_id              = aws_vpc.lab.id
  service_name        = "com.amazonaws.${var.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.private[0].id]
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
  tags                = { Name = "vpce-${each.key}" }
}

resource "aws_instance" "web" {
  count                  = 2
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.micro"
  subnet_id              = aws_subnet.private[count.index].id
  vpc_security_group_ids = [aws_security_group.vms.id]
  iam_instance_profile   = aws_iam_instance_profile.ssm.name
  user_data              = local.cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size = 8
    volume_type = "gp3"
  }
  volume_tags = merge(var.tags, { Name = "vm-web${count.index + 1}" })
  tags        = { Name = "vm-web${count.index + 1}", "Patch Group" = "lab-${var.lab_id}-web" }
  depends_on  = [aws_vpc_endpoint.interface, aws_vpc_endpoint.s3]
}

resource "aws_ssm_patch_baseline" "al2023" {
  name             = "lab-${var.lab_id}-al2023"
  description      = "Security updates rated Critical or Important, approved at once"
  operating_system = "AMAZON_LINUX_2023"
  approval_rule {
    approve_after_days = 0
    compliance_level   = "HIGH"
    patch_filter {
      key    = "CLASSIFICATION"
      values = ["Security"]
    }
    patch_filter {
      key    = "SEVERITY"
      values = ["Critical", "Important"]
    }
  }
}

resource "aws_ssm_patch_group" "web" {
  baseline_id = aws_ssm_patch_baseline.al2023.id
  patch_group = "lab-${var.lab_id}-web"
}

resource "aws_ssm_association" "patch_scan" {
  name                = "AWS-RunPatchBaseline"
  association_name    = "lab-${var.lab_id}-patch-scan"
  schedule_expression = "rate(1 day)"
  parameters          = { Operation = "Scan" }
  targets {
    key    = "tag:Patch Group"
    values = ["lab-${var.lab_id}-web"]
  }
}

resource "aws_ssm_association" "inventory" {
  name                = "AWS-GatherSoftwareInventory"
  association_name    = "lab-${var.lab_id}-inventory"
  schedule_expression = "rate(30 minutes)"
  targets {
    key    = "tag:cloudlabs-lab"
    values = [var.lab_id]
  }
}
