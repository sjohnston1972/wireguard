# cdn.tf
#
# Plain English: lab 26's CloudFront distribution (Europe and North America
# edges only, PriceClass_100; A66). Two origins, the London and the Ireland
# NLBs on plain HTTP port 80, joined in an origin group: London first, and
# Ireland whenever London answers 500, 502, 503 or 504 or cannot be reached
# (one connection attempt, a 3-second timeout, so the failover is quick).
# Nothing is cached (AWS's managed CachingDisabled policy, as lab 09 names
# it), so every request shows which site answered. A CloudFront Function,
# lab-<id>-headers (owned by its name, A4), adds the header
# x-cloudlabs-edge: cloudfront to every request on its way in, and the web
# ACL in waf.tf screens every request first. Deleting the distribution
# disables it everywhere first: destroy_min 15.

locals {
  # AWS's managed cache policy (the same id in every account, as lab 09 uses it).
  caching_disabled = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
  # AWS's managed origin request policy AllViewerExceptHostHeader: sends the viewer's headers (including those the
  # function adds) on to the origin; with CachingDisabled and no policy, CloudFront would strip them.
  all_viewer_except_host = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
}

resource "aws_cloudfront_function" "headers" {
  name    = "lab-${var.lab_id}-headers"
  runtime = "cloudfront-js-2.0"
  comment = "lab ${var.lab_id}: marks each request that came through CloudFront"
  publish = true
  code    = <<-EOT
    function handler(event) {
      var request = event.request;
      request.headers['x-cloudlabs-edge'] = { value: 'cloudfront' };
      return request;
    }
  EOT
}

resource "aws_cloudfront_distribution" "lab" {
  enabled             = true
  comment             = "lab ${var.lab_id}"
  price_class         = "PriceClass_100"
  retain_on_delete    = false
  wait_for_deployment = true
  web_acl_id          = aws_wafv2_web_acl.lab.arn

  origin {
    origin_id           = "london"
    domain_name         = aws_lb.london.dns_name
    connection_attempts = 1
    connection_timeout  = 3
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  origin {
    origin_id   = "ireland"
    domain_name = aws_lb.ireland.dns_name
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  origin_group {
    origin_id = "failover"
    failover_criteria {
      status_codes = [500, 502, 503, 504]
    }
    member {
      origin_id = "london"
    }
    member {
      origin_id = "ireland"
    }
  }

  default_cache_behavior {
    target_origin_id         = "failover"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = local.caching_disabled
    origin_request_policy_id = local.all_viewer_except_host
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.headers.arn
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = { Name = "cdn-lab" }
}
