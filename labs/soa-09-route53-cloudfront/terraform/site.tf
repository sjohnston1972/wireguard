# site.tf
#
# Plain English: lab 09's site, a private bucket cloudlabs-<name prefix>-site
# (every public access block on) holding index.html and health.html. Only
# CloudFront may read it: the bucket policy lets the CloudFront service read
# objects for a distribution of this account (origin access control signs
# each request). The policy is known at plan (ruling P10), so it names this
# account's distributions rather than the one the lab is about to make.

locals {
  bucket     = "cloudlabs-${var.name_prefix}-site"
  bucket_arn = "arn:aws:s3:::cloudlabs-${var.name_prefix}-site"
}

resource "aws_s3_bucket" "site" {
  bucket        = local.bucket
  force_destroy = true
  tags          = { Name = "site" }
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "CloudFrontReadsThroughOriginAccessControl"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${local.bucket_arn}/*"
      Condition = { ArnLike = { "AWS:SourceArn" = "arn:aws:cloudfront::${data.aws_caller_identity.current.account_id}:distribution/*" } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.site]
}

resource "aws_s3_object" "index" {
  bucket       = aws_s3_bucket.site.id
  key          = "index.html"
  content      = "<!doctype html><title>lab ${var.lab_id}</title><h1>Served by CloudFront from a private bucket</h1>\n"
  content_type = "text/html"
}

resource "aws_s3_object" "health" {
  bucket       = aws_s3_bucket.site.id
  key          = "health.html"
  content      = "ok\n"
  content_type = "text/plain"
}
