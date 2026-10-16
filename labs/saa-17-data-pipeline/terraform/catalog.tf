# catalog.tf
#
# Plain English: lab 17's catalogue and queries. The Glue database
# lab_<id> (Glue and Athena take no hyphens; ruling P15) and the crawler
# lab-<id>-events, which reads events/ in the lake and makes a table for it.
# It never runs on a schedule (each run is billed: a Thing to try), and its
# role lab-<id>-crawler may read only the lake and write only this
# database's tables, with no CloudWatch Logs rights, so Glue makes no shared
# log group (V: the crawler still runs). The Athena workgroup lab-<id>-wg
# keeps its results in the lake, refuses queries that would scan more than
# 10 MB, and is deleted with its saved queries.

locals {
  glue_db  = "lab_${replace(var.lab_id, "-", "_")}"
  glue_arn = "arn:${data.aws_partition.current.partition}:glue:${var.region}:${local.account}"
}

resource "aws_glue_catalog_database" "lake" {
  name        = local.glue_db
  description = "lab ${var.lab_id}: the lake's tables"
  tags        = { Name = "glue-lake" }
}

resource "aws_iam_role" "crawler" {
  name                 = "lab-${var.lab_id}-crawler"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "glue.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_policy" "crawler" {
  name = "lab-${var.lab_id}-crawler"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "LabCatalogue", Effect = "Allow", Action = "glue:*", Resource = ["${local.glue_arn}:catalog", "${local.glue_arn}:database/${local.glue_db}", "${local.glue_arn}:table/${local.glue_db}/*"] },
      { Sid = "ReadTheLake", Effect = "Allow", Action = ["s3:GetObject", "s3:ListBucket"], Resource = ["arn:aws:s3:::cloudlabs-${var.name_prefix}-lake", "arn:aws:s3:::cloudlabs-${var.name_prefix}-lake/events/*"] },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "crawler" {
  role       = aws_iam_role.crawler.name
  policy_arn = aws_iam_policy.crawler.arn
}

resource "aws_glue_crawler" "events" {
  name          = "lab-${var.lab_id}-events"
  database_name = aws_glue_catalog_database.lake.name
  role          = aws_iam_role.crawler.arn
  s3_target {
    path = "s3://${aws_s3_bucket.lake.bucket}/events/"
  }
  schema_change_policy {
    delete_behavior = "DELETE_FROM_DATABASE"
    update_behavior = "UPDATE_IN_DATABASE"
  }
  tags       = { Name = "crawler-events" }
  depends_on = [aws_iam_role_policy_attachment.crawler]
}

resource "aws_athena_workgroup" "wg" {
  name          = "lab-${var.lab_id}-wg"
  force_destroy = true
  configuration {
    enforce_workgroup_configuration    = true
    publish_cloudwatch_metrics_enabled = false
    bytes_scanned_cutoff_per_query     = 10485760
    result_configuration {
      output_location = "s3://${aws_s3_bucket.lake.bucket}/athena-results/"
    }
  }
  tags = { Name = "athena-wg" }
}
