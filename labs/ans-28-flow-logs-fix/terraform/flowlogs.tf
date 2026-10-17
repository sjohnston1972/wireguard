# flowlogs.tf
#
# Plain English: VPC Flow Logs for lab 28's service VPC, every accepted and
# rejected flow, twice. flow-service writes one-minute records to the log
# group /cloudlabs/<id>/flow (one day; A56) as the lab's role
# lab-<id>-flowlogs, allowed only that group. flow-service-s3 writes the same
# records to the lab's own bucket cloudlabs-<name_prefix>-flowlogs, as
# plain text in Hive-style folders by the hour (aws-account-id=,
# aws-service=, aws-region=, year=, month=, day=, hour=), which athena.tf's
# table reads. The bucket blocks public access, empties itself at
# tear-down, and lets only AWS's log delivery service write, for this
# account only (rulings P7, P8).

locals {
  account          = data.aws_caller_identity.current.account_id
  flowlogs_bucket  = "cloudlabs-${var.name_prefix}-flowlogs"
  flowlogs_arn     = "arn:aws:s3:::cloudlabs-${var.name_prefix}-flowlogs"
  flow_group       = "/cloudlabs/${var.lab_id}/flow"
  flow_group_arn   = "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/cloudlabs/${var.lab_id}/flow"
  flowlogs_s3_root = "AWSLogs/aws-account-id=${data.aws_caller_identity.current.account_id}"
}

resource "aws_cloudwatch_log_group" "flow" {
  name              = local.flow_group
  retention_in_days = 1
}

resource "aws_iam_role" "flowlogs" {
  name                 = "lab-${var.lab_id}-flowlogs"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = local.account } }
    }]
  })
}

resource "aws_iam_policy" "flowlogs" {
  name = "lab-${var.lab_id}-flowlogs"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "LabFlowLogGroup", Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"], Resource = "${local.flow_group_arn}:*" },
      { Sid = "FindGroups", Effect = "Allow", Action = "logs:DescribeLogGroups", Resource = "*" },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "flowlogs" {
  role       = aws_iam_role.flowlogs.name
  policy_arn = aws_iam_policy.flowlogs.arn
}

resource "aws_flow_log" "service" {
  vpc_id                   = aws_vpc.service.id
  traffic_type             = "ALL"
  log_destination_type     = "cloud-watch-logs"
  log_destination          = aws_cloudwatch_log_group.flow.arn
  iam_role_arn             = aws_iam_role.flowlogs.arn
  max_aggregation_interval = 60
  tags                     = { Name = "flow-service" }
  depends_on               = [aws_iam_role_policy_attachment.flowlogs]
}

resource "aws_s3_bucket" "flowlogs" {
  bucket        = local.flowlogs_bucket
  force_destroy = true
  tags          = { Name = "flowlogs" }
}

resource "aws_s3_bucket_public_access_block" "flowlogs" {
  bucket                  = aws_s3_bucket.flowlogs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "flowlogs" {
  bucket = aws_s3_bucket.flowlogs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "LogDeliveryWrite"
        Effect    = "Allow"
        Principal = { Service = "delivery.logs.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${local.flowlogs_arn}/${local.flowlogs_s3_root}/*"
        Condition = { StringEquals = { "aws:SourceAccount" = local.account } }
      },
      {
        Sid       = "LogDeliveryAclCheck"
        Effect    = "Allow"
        Principal = { Service = "delivery.logs.amazonaws.com" }
        Action    = "s3:GetBucketAcl"
        Resource  = local.flowlogs_arn
        Condition = { StringEquals = { "aws:SourceAccount" = local.account } }
      },
    ]
  })
  depends_on = [aws_s3_bucket_public_access_block.flowlogs]
}

resource "aws_flow_log" "service_s3" {
  vpc_id                   = aws_vpc.service.id
  traffic_type             = "ALL"
  log_destination_type     = "s3"
  log_destination          = aws_s3_bucket.flowlogs.arn
  max_aggregation_interval = 60
  destination_options {
    file_format                = "plain-text"
    hive_compatible_partitions = true
    per_hour_partition         = true
  }
  tags       = { Name = "flow-service-s3" }
  depends_on = [aws_s3_bucket_policy.flowlogs]
}
