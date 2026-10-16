# s3.tf
#
# Plain English: lab 14's bucket, cloudlabs-<name_prefix>-tiers, private and
# removable with its objects. Objects under reports/ go to S3
# Intelligent-Tiering by the daily lifecycle run (it moves an object to cheaper
# tiers when nobody reads it, and to the archive tiers after 90 and 180 days);
# objects under logs/ go to Standard-IA after 30 days, Glacier Instant
# Retrieval after 90, and are deleted after a year. The run skips objects under
# 128 KB, so the two sample objects (one uploaded with its class, one without)
# show the classes without waiting.

resource "aws_s3_bucket" "tiers" {
  bucket        = "cloudlabs-${var.name_prefix}-tiers"
  force_destroy = true
  tags          = { Name = "tiers" }
}

resource "aws_s3_bucket_public_access_block" "tiers" {
  bucket                  = aws_s3_bucket.tiers.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_intelligent_tiering_configuration" "archive" {
  bucket = aws_s3_bucket.tiers.id
  name   = "archive"
  status = "Enabled"
  tiering {
    access_tier = "ARCHIVE_ACCESS"
    days        = 90
  }
  tiering {
    access_tier = "DEEP_ARCHIVE_ACCESS"
    days        = 180
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "tiers" {
  bucket = aws_s3_bucket.tiers.id
  rule {
    id     = "reports-to-intelligent-tiering"
    status = "Enabled"
    filter {
      prefix = "reports/"
    }
    transition {
      days          = 0
      storage_class = "INTELLIGENT_TIERING"
    }
  }
  rule {
    id     = "logs"
    status = "Enabled"
    filter {
      prefix = "logs/"
    }
    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
    transition {
      days          = 90
      storage_class = "GLACIER_IR"
    }
    expiration {
      days = 365
    }
  }
}

resource "aws_s3_object" "report" {
  bucket        = aws_s3_bucket.tiers.id
  key           = "reports/hello.txt"
  content       = "an object stored straight into Intelligent-Tiering\n"
  content_type  = "text/plain"
  storage_class = "INTELLIGENT_TIERING"
}

resource "aws_s3_object" "log" {
  bucket       = aws_s3_bucket.tiers.id
  key          = "logs/first.log"
  content      = "a log line; the logs/ rule moves objects of 128 KB and up to Standard-IA after 30 days\n"
  content_type = "text/plain"
}
