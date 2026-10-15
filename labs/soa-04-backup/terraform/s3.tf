# s3.tf
#
# Plain English: lab 04's buckets, cloudlabs-<name_prefix>-src and -dst,
# private, versioned and removable with every version (force_destroy). The
# source has a lifecycle rule (current objects to Standard-IA after 30 days,
# old versions gone after 30) and replicates every object and delete marker
# to the destination, through a role and policy of the lab's own whose
# documents name the buckets by their ARNs, known at plan (ruling A42).

locals {
  src_bucket = "cloudlabs-${var.name_prefix}-src"
  dst_bucket = "cloudlabs-${var.name_prefix}-dst"
  src_arn    = "arn:aws:s3:::cloudlabs-${var.name_prefix}-src"
  dst_arn    = "arn:aws:s3:::cloudlabs-${var.name_prefix}-dst"
}

resource "aws_s3_bucket" "src" {
  bucket        = local.src_bucket
  force_destroy = true
  tags          = { Name = "src" }
}

resource "aws_s3_bucket" "dst" {
  bucket        = local.dst_bucket
  force_destroy = true
  tags          = { Name = "dst" }
}

resource "aws_s3_bucket_public_access_block" "src" {
  bucket                  = aws_s3_bucket.src.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "dst" {
  bucket                  = aws_s3_bucket.dst.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "src" {
  bucket = aws_s3_bucket.src.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_versioning" "dst" {
  bucket = aws_s3_bucket.dst.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "src" {
  bucket = aws_s3_bucket.src.id
  rule {
    id     = "tidy"
    status = "Enabled"
    filter {}
    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
  depends_on = [aws_s3_bucket_versioning.src]
}

resource "aws_iam_role" "replication" {
  name                 = "lab-${var.lab_id}-replication"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "s3.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_policy" "replication" {
  name = "lab-${var.lab_id}-replication"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetReplicationConfiguration", "s3:ListBucket"], Resource = local.src_arn },
      { Effect = "Allow", Action = ["s3:GetObjectVersionForReplication", "s3:GetObjectVersionAcl", "s3:GetObjectVersionTagging"], Resource = "${local.src_arn}/*" },
      { Effect = "Allow", Action = ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags"], Resource = "${local.dst_arn}/*" },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "replication" {
  role       = aws_iam_role.replication.name
  policy_arn = aws_iam_policy.replication.arn
}

resource "aws_s3_bucket_replication_configuration" "src" {
  bucket = aws_s3_bucket.src.id
  role   = aws_iam_role.replication.arn
  rule {
    id     = "all"
    status = "Enabled"
    filter {}
    delete_marker_replication {
      status = "Enabled"
    }
    destination {
      bucket        = aws_s3_bucket.dst.arn
      storage_class = "STANDARD"
    }
  }
  depends_on = [aws_s3_bucket_versioning.src, aws_s3_bucket_versioning.dst, aws_iam_role_policy_attachment.replication]
}

resource "aws_s3_object" "hello" {
  bucket       = aws_s3_bucket.src.id
  key          = "hello.txt"
  content      = "first version\n"
  content_type = "text/plain"
  depends_on   = [aws_s3_bucket_replication_configuration.src]
}
