# delivery.tf
#
# Plain English: lab 17's lake. The bucket cloudlabs-<name_prefix>-lake,
# private and removable with its objects, and the delivery stream
# lab-<id>-to-s3: Firehose reads the Kinesis stream and writes its records to
# events/ every minute (or each MB), failures to errors/, as the role
# lab-<id>-firehose, allowed only to read that stream and write that bucket.
# Firehose's own error logging stays off (it would make a log group outside
# /cloudlabs/; ruling P15). A 20-second wait lets the new role reach Firehose,
# which checks it at create (as lab 04's replication role).

resource "aws_s3_bucket" "lake" {
  bucket        = "cloudlabs-${var.name_prefix}-lake"
  force_destroy = true
  tags          = { Name = "lake" }
}

resource "aws_s3_bucket_public_access_block" "lake" {
  bucket                  = aws_s3_bucket.lake.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_iam_role" "firehose" {
  name                 = "lab-${var.lab_id}-firehose"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "firehose.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_policy" "firehose" {
  name = "lab-${var.lab_id}-firehose"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "ReadTheStream", Effect = "Allow", Action = ["kinesis:DescribeStream", "kinesis:DescribeStreamSummary", "kinesis:GetShardIterator", "kinesis:GetRecords", "kinesis:ListShards"], Resource = local.stream_arn },
      { Sid = "WriteTheLake", Effect = "Allow", Action = ["s3:AbortMultipartUpload", "s3:GetBucketLocation", "s3:GetObject", "s3:ListBucket", "s3:ListBucketMultipartUploads", "s3:PutObject"], Resource = ["arn:aws:s3:::cloudlabs-${var.name_prefix}-lake", "arn:aws:s3:::cloudlabs-${var.name_prefix}-lake/*"] },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "firehose" {
  role       = aws_iam_role.firehose.name
  policy_arn = aws_iam_policy.firehose.arn
}

resource "time_sleep" "firehose_role" {
  create_duration = "20s"
  depends_on      = [aws_iam_role_policy_attachment.firehose]
}

resource "aws_kinesis_firehose_delivery_stream" "to_s3" {
  name        = "lab-${var.lab_id}-to-s3"
  destination = "extended_s3"

  kinesis_source_configuration {
    kinesis_stream_arn = aws_kinesis_stream.events.arn
    role_arn           = aws_iam_role.firehose.arn
  }
  extended_s3_configuration {
    role_arn            = aws_iam_role.firehose.arn
    bucket_arn          = aws_s3_bucket.lake.arn
    prefix              = "events/"
    error_output_prefix = "errors/!{firehose:error-output-type}/"
    buffering_size      = 1
    buffering_interval  = 60
    compression_format  = "UNCOMPRESSED"
    cloudwatch_logging_options {
      enabled = false
    }
  }
  tags       = { Name = "firehose-to-s3" }
  depends_on = [time_sleep.firehose_role]
}
