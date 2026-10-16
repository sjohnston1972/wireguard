# s3.tf
#
# Plain English: lab 15's bucket, cloudlabs-<name_prefix>-data, private and
# encrypted by default with the lab's key (SSE-KMS, with an S3 Bucket Key so
# S3 asks KMS far less often). Its policy refuses any request not over TLS
# and any upload that asks for encryption other than KMS. It is known at plan,
# naming the bucket by its built ARN (ruling A68); restricting it to the lab's
# endpoint is a Thing to try (ruling P18).

locals {
  bucket     = "cloudlabs-${var.name_prefix}-data"
  bucket_arn = "arn:aws:s3:::cloudlabs-${var.name_prefix}-data"
}

resource "aws_s3_bucket" "data" {
  bucket        = local.bucket
  force_destroy = true
  tags          = { Name = "data" }
}

resource "aws_s3_bucket_public_access_block" "data" {
  bucket                  = aws_s3_bucket.data.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "data" {
  bucket = aws_s3_bucket.data.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_policy" "data" {
  bucket = aws_s3_bucket.data.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "TlsOnly", Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [local.bucket_arn, "${local.bucket_arn}/*"], Condition = { Bool = { "aws:SecureTransport" = "false" } } },
      { Sid = "KmsUploadsOnly", Effect = "Deny", Principal = "*", Action = "s3:PutObject", Resource = "${local.bucket_arn}/*", Condition = { StringNotEqualsIfExists = { "s3:x-amz-server-side-encryption" = "aws:kms" } } },
    ]
  })
  depends_on = [aws_s3_bucket_public_access_block.data]
}

resource "aws_s3_object" "secret" {
  bucket       = aws_s3_bucket.data.id
  key          = "secret.txt"
  content      = "encrypted at rest with the lab's own key\n"
  content_type = "text/plain"
  depends_on   = [aws_s3_bucket_server_side_encryption_configuration.data]
}
