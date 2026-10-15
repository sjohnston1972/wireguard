# config.tf
#
# Plain English: AWS Config in lab 02 (the only lab allowed a recorder: one
# per region per account). It records security groups and instances only,
# delivers snapshots to the lab's own bucket, and runs the managed rule
# restricted-ssh (INCOMING_SSH_DISABLED) with automatic remediation by the
# SSM Automation document AWS-DisablePublicAccessForSecurityGroup, under a
# role of the lab's own. The rule is scoped to this lab's tag, so the
# remediation can never touch another group in the region (Config refuses a
# scope with both resource types and a tag; the managed rule judges security
# groups only).
# sg-demo is an empty group to try it on. The recorder and delivery channel
# cannot carry tags, so they are named lab-<id>-* (ruling A4).

locals {
  config_bucket     = "cloudlabs-${var.name_prefix}-config"
  config_bucket_arn = "arn:aws:s3:::cloudlabs-${var.name_prefix}-config"
}

resource "aws_s3_bucket" "config" {
  bucket        = local.config_bucket
  force_destroy = true
  tags          = { Name = "config-snapshots" }
}

resource "aws_s3_bucket_public_access_block" "config" {
  bucket                  = aws_s3_bucket.config.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_iam_role" "config" {
  name                 = "lab-${var.lab_id}-config"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "config.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "config_managed" {
  role       = aws_iam_role.config.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWS_ConfigRole"
}

resource "aws_iam_policy" "config_delivery" {
  name = "lab-${var.lab_id}-config-delivery"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetBucketAcl", "s3:ListBucket"], Resource = local.config_bucket_arn },
      { Effect = "Allow", Action = ["s3:PutObject"], Resource = "${local.config_bucket_arn}/AWSLogs/*" },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "config_delivery" {
  role       = aws_iam_role.config.name
  policy_arn = aws_iam_policy.config_delivery.arn
}

resource "aws_config_configuration_recorder" "lab" {
  name     = "lab-${var.lab_id}-recorder"
  role_arn = aws_iam_role.config.arn
  recording_group {
    all_supported                 = false
    include_global_resource_types = false
    resource_types                = ["AWS::EC2::SecurityGroup", "AWS::EC2::Instance"]
  }
}

resource "aws_config_delivery_channel" "lab" {
  name           = "lab-${var.lab_id}-channel"
  s3_bucket_name = aws_s3_bucket.config.bucket
  depends_on     = [aws_config_configuration_recorder.lab, aws_iam_role_policy_attachment.config_delivery]
}

resource "aws_config_configuration_recorder_status" "lab" {
  name       = "lab-${var.lab_id}-recorder"
  is_enabled = true
  depends_on = [aws_config_configuration_recorder.lab, aws_config_delivery_channel.lab]
}

resource "aws_config_config_rule" "restricted_ssh" {
  name = "lab-${var.lab_id}-restricted-ssh"
  source {
    owner             = "AWS"
    source_identifier = "INCOMING_SSH_DISABLED"
  }
  scope {
    tag_key   = "cloudlabs-lab"
    tag_value = var.lab_id
  }
  depends_on = [aws_config_configuration_recorder_status.lab]
}

resource "aws_iam_role" "remediation" {
  name                 = "lab-${var.lab_id}-remediation"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ssm.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "remediation_managed" {
  role       = aws_iam_role.remediation.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonSSMAutomationRole"
}

resource "aws_iam_policy" "remediation" {
  name = "lab-${var.lab_id}-remediation"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["ec2:DescribeSecurityGroups", "ec2:RevokeSecurityGroupIngress"], Resource = "*" }]
  })
}

resource "aws_iam_role_policy_attachment" "remediation" {
  role       = aws_iam_role.remediation.name
  policy_arn = aws_iam_policy.remediation.arn
}

resource "aws_config_remediation_configuration" "restricted_ssh" {
  config_rule_name           = aws_config_config_rule.restricted_ssh.name
  target_type                = "SSM_DOCUMENT"
  target_id                  = "AWS-DisablePublicAccessForSecurityGroup"
  resource_type              = "AWS::EC2::SecurityGroup"
  automatic                  = true
  maximum_automatic_attempts = 3
  retry_attempt_seconds      = 60
  parameter {
    name         = "AutomationAssumeRole"
    static_value = aws_iam_role.remediation.arn
  }
  parameter {
    name           = "GroupId"
    resource_value = "RESOURCE_ID"
  }
}

resource "aws_security_group" "demo" {
  name        = "lab-demo"
  description = "Empty and attached to nothing: open SSH here to watch Config remove it"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-demo" }
}
