# cdn.tf
#
# Plain English: lab 09's CloudFront distribution (Europe and North America
# edges only, PriceClass_100) in front of the site bucket, through an origin
# access control that signs every request with SigV4. Pages are cached with
# AWS's managed CachingOptimized policy and served over HTTPS; /health.html,
# which the Route 53 health check reads, is never cached and answers HTTP too,
# so deleting it fails the check within a minute or two. Deleting the
# distribution first disables it and waits for that to reach every edge
# (several minutes: destroy_min 12).

locals {
  # AWS's managed cache policies (the same ids in every account; V: Task 12).
  caching_optimized = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  caching_disabled  = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
}

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "lab-${var.lab_id}-${var.name_prefix}"
  description                       = "lab ${var.lab_id}, CloudFront signs its requests to the site bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  comment             = "lab ${var.lab_id}"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  retain_on_delete    = false
  wait_for_deployment = true

  origin {
    origin_id                = "site"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    target_origin_id       = "site"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = local.caching_optimized
    compress               = true
  }

  ordered_cache_behavior {
    path_pattern           = "/health.html"
    target_origin_id       = "site"
    viewer_protocol_policy = "allow-all"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = local.caching_disabled
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = { Name = "cdn-site" }
}
