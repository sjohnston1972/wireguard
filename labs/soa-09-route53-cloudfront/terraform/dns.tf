# dns.tf
#
# Plain English: lab 09's public hosted zone, <name prefix>.labs.clydeford.net
# (ruling A27). It is never delegated from clydeford.net, so the internet
# never asks it: you ask its own name servers directly (dig @<name server>).
# Two names stand for two releases of the site, blue and green (both point at
# the distribution); app answers blue 70% of the time and green 30%
# (weighted); www answers blue while the health check of /health.html passes,
# and sorry when it fails (failover); cdn is an alias straight to the
# distribution. One health check (ruling P8: Route 53 may bill a whole month).

locals {
  zone = "${var.name_prefix}.labs.clydeford.net"
  cdn  = aws_cloudfront_distribution.site.domain_name
}

resource "aws_route53_zone" "lab" {
  name          = local.zone
  comment       = "lab ${var.lab_id}, not delegated, ask its own name servers"
  force_destroy = true
  tags          = { Name = "zone-lab" }
}

resource "aws_route53_health_check" "primary" {
  fqdn              = aws_cloudfront_distribution.site.domain_name
  type              = "HTTP"
  port              = 80
  resource_path     = "/health.html"
  request_interval  = 30
  failure_threshold = 3
  measure_latency   = false
  tags              = { Name = "hc-primary" }
}

resource "aws_route53_record" "release" {
  for_each = toset(["blue", "green", "sorry"])
  zone_id  = aws_route53_zone.lab.zone_id
  name     = "${each.key}.${local.zone}"
  type     = "CNAME"
  ttl      = 60
  records  = [local.cdn]
}

resource "aws_route53_record" "app" {
  for_each       = { blue = 70, green = 30 }
  zone_id        = aws_route53_zone.lab.zone_id
  name           = "app.${local.zone}"
  type           = "CNAME"
  ttl            = 60
  set_identifier = each.key
  records        = ["${each.key}.${local.zone}"]
  weighted_routing_policy {
    weight = each.value
  }
}

resource "aws_route53_record" "www_primary" {
  zone_id         = aws_route53_zone.lab.zone_id
  name            = "www.${local.zone}"
  type            = "CNAME"
  ttl             = 60
  set_identifier  = "primary"
  health_check_id = aws_route53_health_check.primary.id
  records         = ["blue.${local.zone}"]
  failover_routing_policy {
    type = "PRIMARY"
  }
}

resource "aws_route53_record" "www_secondary" {
  zone_id        = aws_route53_zone.lab.zone_id
  name           = "www.${local.zone}"
  type           = "CNAME"
  ttl            = 60
  set_identifier = "secondary"
  records        = ["sorry.${local.zone}"]
  failover_routing_policy {
    type = "SECONDARY"
  }
}

resource "aws_route53_record" "cdn" {
  zone_id = aws_route53_zone.lab.zone_id
  name    = "cdn.${local.zone}"
  type    = "A"
  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}
