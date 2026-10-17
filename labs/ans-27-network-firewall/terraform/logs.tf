# logs.tf
#
# Plain English: where lab 27's firewall writes its alerts: the lab's own
# bucket cloudlabs-<name_prefix>-nfwlogs, under alerts/ (ruling P8: vended
# logs go to the lab's bucket, never to CloudWatch Logs, whose delivery
# would write an account-wide policy). The bucket blocks every kind of
# public access, empties itself at tear-down, and lets only AWS's log
# delivery service write, for this account only (ruling P7). Each alert
# record names the flow, the domain and the action taken.

locals {
  nfw_bucket = "cloudlabs-${var.name_prefix}-nfwlogs"
  nfw_arn    = "arn:aws:s3:::cloudlabs-${var.name_prefix}-nfwlogs"
}

resource "aws_s3_bucket" "nfwlogs" {
  bucket        = local.nfw_bucket
  force_destroy = true
  tags          = { Name = "nfwlogs" }
}

resource "aws_s3_bucket_public_access_block" "nfwlogs" {
  bucket                  = aws_s3_bucket.nfwlogs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "nfwlogs" {
  bucket = aws_s3_bucket.nfwlogs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "LogDeliveryWrite"
        Effect    = "Allow"
        Principal = { Service = "delivery.logs.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "${local.nfw_arn}/alerts/AWSLogs/${data.aws_caller_identity.current.account_id}/*"
        Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
      },
      {
        Sid       = "LogDeliveryAclCheck"
        Effect    = "Allow"
        Principal = { Service = "delivery.logs.amazonaws.com" }
        Action    = "s3:GetBucketAcl"
        Resource  = local.nfw_arn
        Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
      },
    ]
  })
  depends_on = [aws_s3_bucket_public_access_block.nfwlogs]
}

resource "aws_networkfirewall_logging_configuration" "lab" {
  firewall_arn = aws_networkfirewall_firewall.lab.arn
  logging_configuration {
    log_destination_config {
      log_destination = {
        bucketName = aws_s3_bucket.nfwlogs.bucket
        prefix     = "alerts"
      }
      log_destination_type = "S3"
      log_type             = "ALERT"
    }
  }
  depends_on = [time_sleep.firewall_tags, aws_s3_bucket_policy.nfwlogs]
}
