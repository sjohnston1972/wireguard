# dns.tf
#
# Plain English: lab 16's failover name. A private hosted zone,
# dr.<name_prefix>.internal, answering only inside the lab's two VPCs
# (ruling P6), and one name in it, app: London's address while the health
# check is healthy, Ireland's standby address when it is not. Private zones
# cannot probe an address, so the health check follows the London alarm
# (a CloudWatch-metric health check; unhealthy while London reports nothing,
# as the alarm treats missing data; for the first minutes after deploy the
# name may answer Ireland's address).

resource "aws_route53_zone" "dr" {
  name          = "dr.${var.name_prefix}.internal"
  force_destroy = true
  vpc {
    vpc_id     = aws_vpc.lab.id
    vpc_region = var.region
  }
  vpc {
    vpc_id     = aws_vpc.dr.id
    vpc_region = var.secondary_region
  }
  tags = { Name = "zone-dr" }
}

resource "aws_route53_health_check" "app" {
  type                            = "CLOUDWATCH_METRIC"
  cloudwatch_alarm_name           = aws_cloudwatch_metric_alarm.app_down.alarm_name
  cloudwatch_alarm_region         = var.region
  insufficient_data_health_status = "Unhealthy"
  tags                            = { Name = "hc-app" }
}

resource "aws_route53_record" "app_london" {
  zone_id         = aws_route53_zone.dr.zone_id
  name            = "app.${aws_route53_zone.dr.name}"
  type            = "A"
  ttl             = 30
  records         = [aws_instance.app.private_ip]
  set_identifier  = "london"
  health_check_id = aws_route53_health_check.app.id
  failover_routing_policy {
    type = "PRIMARY"
  }
}

resource "aws_route53_record" "app_ireland" {
  zone_id        = aws_route53_zone.dr.zone_id
  name           = "app.${aws_route53_zone.dr.name}"
  type           = "A"
  ttl            = 30
  records        = [local.dr_ip]
  set_identifier = "ireland"
  failover_routing_policy {
    type = "SECONDARY"
  }
}
