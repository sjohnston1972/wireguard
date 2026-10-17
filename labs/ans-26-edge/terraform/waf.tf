# waf.tf
#
# Plain English: lab 26's WAF web ACL, lab-<id>-waf, for CloudFront, so it
# lives in us-east-1 (this resource's own region; no third provider block,
# ruling P9). It allows by default and has two rules: AWS's managed Core rule
# set (common attacks such as cross-site scripting in a query string,
# blocked), and a rate-based rule that blocks any one address sending more
# than 100 requests in 5 minutes. AWS's paid rule groups (Bot Control,
# account takeover and creation fraud, Anti-DDoS) are never used here.
# Metrics and sampled requests are on, so the WAF console shows what it did.

resource "aws_wafv2_web_acl" "lab" {
  region      = "us-east-1"
  name        = "lab-${var.lab_id}-waf"
  description = "lab ${var.lab_id}: the CloudFront distribution's web ACL"
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "common"
    priority = 1
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "lab-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "rate"
    priority = 2
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit                 = 100
        evaluation_window_sec = 300
        aggregate_key_type    = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "lab-rate"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "lab-waf"
    sampled_requests_enabled   = true
  }

  tags = { Name = "waf-lab" }
}
