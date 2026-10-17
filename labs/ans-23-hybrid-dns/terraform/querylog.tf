# querylog.tf
#
# Plain English: lab 23's Resolver query logs: every DNS question asked in
# vpc-lab, written as files to the lab's own bucket,
# cloudlabs-<name_prefix>-dnslogs (ruling P8: vended logs go to the lab's
# bucket, never CloudWatch Logs, whose delivery would write an account-wide
# policy). The bucket is private and removable; its policy lets AWS's log
# delivery service write under AWSLogs/<account>/ and check the bucket's ACL,
# and only for this account (ruling P7: aws:SourceAccount). The policy is
# known at plan, built from the caller identity (ruling A68). The VPC's
# association waits 20 seconds after the config is made (ruling P21).

locals {
  dnslogs_bucket = "cloudlabs-${var.name_prefix}-dnslogs"
  dnslogs_arn    = "arn:aws:s3:::cloudlabs-${var.name_prefix}-dnslogs"
}

resource "aws_s3_bucket" "dnslogs" {
  bucket        = local.dnslogs_bucket
  force_destroy = true
  tags          = { Name = "dnslogs" }
}

resource "aws_s3_bucket_public_access_block" "dnslogs" {
  bucket                  = aws_s3_bucket.dnslogs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "dnslogs" {
  bucket = aws_s3_bucket.dnslogs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AWSLogDeliveryWrite"
        Effect    = "Allow"
        Principal = { Service = "delivery.logs.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${local.dnslogs_arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"
        Condition = { StringEquals = { "s3:x-amz-acl" = "bucket-owner-full-control", "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
      },
      {
        Sid       = "AWSLogDeliveryAclCheck"
        Effect    = "Allow"
        Principal = { Service = "delivery.logs.amazonaws.com" }
        Action    = "s3:GetBucketAcl"
        Resource  = local.dnslogs_arn
        Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
      },
    ]
  })
  depends_on = [aws_s3_bucket_public_access_block.dnslogs]
}

resource "aws_route53_resolver_query_log_config" "lab" {
  name            = "lab-${var.lab_id}-queries"
  destination_arn = aws_s3_bucket.dnslogs.arn
  tags            = { Name = "querylog" }
  depends_on      = [aws_s3_bucket_policy.dnslogs]
}

resource "aws_route53_resolver_query_log_config_association" "lab" {
  resolver_query_log_config_id = aws_route53_resolver_query_log_config.lab.id
  resource_id                  = aws_vpc.lab.id
  depends_on                   = [time_sleep.resolver_tags]
}
