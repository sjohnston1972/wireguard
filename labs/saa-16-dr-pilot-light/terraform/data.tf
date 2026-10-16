# data.tf
#
# Plain English: lab 16's data, already in Ireland. Two buckets,
# cloudlabs-<name_prefix>-london and -ireland, versioned and removable; every
# object and delete marker put in London is replicated to Ireland by the
# lab's own role (its documents name both buckets by their ARNs, known at
# plan). And a DynamoDB table, lab-<id>-orders, on demand, with a replica in
# Ireland that carries the lab's tags (a global table; rulings P3, P10).

locals {
  london_bucket  = "cloudlabs-${var.name_prefix}-london"
  ireland_bucket = "cloudlabs-${var.name_prefix}-ireland"
  london_arn     = "arn:aws:s3:::cloudlabs-${var.name_prefix}-london"
  ireland_arn    = "arn:aws:s3:::cloudlabs-${var.name_prefix}-ireland"
}

resource "aws_s3_bucket" "london" {
  bucket        = local.london_bucket
  force_destroy = true
  tags          = { Name = "london" }
}

resource "aws_s3_bucket" "ireland" {
  provider      = aws.secondary
  bucket        = local.ireland_bucket
  force_destroy = true
  tags          = { Name = "ireland" }
}

resource "aws_s3_bucket_public_access_block" "london" {
  bucket                  = aws_s3_bucket.london.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "ireland" {
  provider                = aws.secondary
  bucket                  = aws_s3_bucket.ireland.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "london" {
  bucket = aws_s3_bucket.london.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_versioning" "ireland" {
  provider = aws.secondary
  bucket   = aws_s3_bucket.ireland.id
  versioning_configuration {
    status = "Enabled"
  }
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
      { Effect = "Allow", Action = ["s3:GetReplicationConfiguration", "s3:ListBucket"], Resource = local.london_arn },
      { Effect = "Allow", Action = ["s3:GetObjectVersionForReplication", "s3:GetObjectVersionAcl", "s3:GetObjectVersionTagging"], Resource = "${local.london_arn}/*" },
      { Effect = "Allow", Action = ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags"], Resource = "${local.ireland_arn}/*" },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "replication" {
  role       = aws_iam_role.replication.name
  policy_arn = aws_iam_policy.replication.arn
}

# A new role takes a moment to reach S3 (as lab 04 found).
resource "time_sleep" "replication_role" {
  create_duration = "20s"
  depends_on      = [aws_iam_role_policy_attachment.replication]
}

resource "aws_s3_bucket_replication_configuration" "london" {
  bucket = aws_s3_bucket.london.id
  role   = aws_iam_role.replication.arn
  rule {
    id     = "to-ireland"
    status = "Enabled"
    filter {}
    delete_marker_replication {
      status = "Enabled"
    }
    destination {
      bucket        = aws_s3_bucket.ireland.arn
      storage_class = "STANDARD"
    }
  }
  depends_on = [aws_s3_bucket_versioning.london, aws_s3_bucket_versioning.ireland, time_sleep.replication_role]
}

resource "aws_s3_object" "hello" {
  bucket       = aws_s3_bucket.london.id
  key          = "hello.txt"
  content      = "written in London, replicated to Ireland\n"
  content_type = "text/plain"
  depends_on   = [aws_s3_bucket_replication_configuration.london]
}

resource "aws_dynamodb_table" "orders" {
  name                        = "lab-${var.lab_id}-orders"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "id"
  stream_enabled              = true
  stream_view_type            = "NEW_AND_OLD_IMAGES"
  deletion_protection_enabled = false

  attribute {
    name = "id"
    type = "S"
  }
  replica {
    region_name    = var.secondary_region
    propagate_tags = true
  }
  tags = { Name = "table-orders" }
}
