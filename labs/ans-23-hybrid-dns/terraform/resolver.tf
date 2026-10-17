# resolver.tf
#
# Plain English: lab 23's Route 53 Resolver in the cloud VPC (ruling P12).
# An inbound endpoint, rslvr-in, that the data centre's DNS server asks about
# cloud names, and an outbound endpoint, rslvr-out, through which the cloud
# VPC asks the data centre about corp names: each with an address in both
# private subnets, chosen by AWS (dnsmasq's configuration names the inbound
# addresses by reference, so vm-dns is made after the inbound endpoint). One
# FORWARD rule, corp.<name_prefix>.internal to dnsmasq, used by vpc-lab. And
# the private hosted zone cloud.<name_prefix>.internal (ruling A88: an
# .internal name) with one record, app, vm-cloud's address. The rule's
# association waits 20 seconds after the rule is made (ruling P21: Resolver's
# tags are not yet proven to be readable at once).

locals {
  corp_domain  = "corp.${var.name_prefix}.internal"
  cloud_domain = "cloud.${var.name_prefix}.internal"
}

resource "aws_security_group" "resolver" {
  name        = "lab-resolver"
  description = "Resolver endpoints: DNS in from the data centre, DNS out to vm-dns"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-resolver" }
}

resource "aws_vpc_security_group_ingress_rule" "resolver_udp" {
  security_group_id = aws_security_group.resolver.id
  cidr_ipv4         = local.onprem_cidr
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
}

resource "aws_vpc_security_group_ingress_rule" "resolver_tcp" {
  security_group_id = aws_security_group.resolver.id
  cidr_ipv4         = local.onprem_cidr
  ip_protocol       = "tcp"
  from_port         = 53
  to_port           = 53
}

resource "aws_vpc_security_group_egress_rule" "resolver_out_udp" {
  security_group_id = aws_security_group.resolver.id
  cidr_ipv4         = "${local.dns_ip}/32"
  ip_protocol       = "udp"
  from_port         = 53
  to_port           = 53
}

resource "aws_vpc_security_group_egress_rule" "resolver_out_tcp" {
  security_group_id = aws_security_group.resolver.id
  cidr_ipv4         = "${local.dns_ip}/32"
  ip_protocol       = "tcp"
  from_port         = 53
  to_port           = 53
}

resource "aws_route53_resolver_endpoint" "inbound" {
  name               = "lab-${var.lab_id}-in"
  direction          = "INBOUND"
  security_group_ids = [aws_security_group.resolver.id]
  protocols          = ["Do53"]

  ip_address {
    subnet_id = aws_subnet.private[0].id
  }
  ip_address {
    subnet_id = aws_subnet.private[1].id
  }
  tags = { Name = "rslvr-in" }
}

resource "aws_route53_resolver_endpoint" "outbound" {
  name               = "lab-${var.lab_id}-out"
  direction          = "OUTBOUND"
  security_group_ids = [aws_security_group.resolver.id]
  protocols          = ["Do53"]

  ip_address {
    subnet_id = aws_subnet.private[0].id
  }
  ip_address {
    subnet_id = aws_subnet.private[1].id
  }
  tags = { Name = "rslvr-out" }
}

resource "aws_route53_resolver_rule" "corp" {
  name                 = "lab-${var.lab_id}-corp"
  rule_type            = "FORWARD"
  domain_name          = local.corp_domain
  resolver_endpoint_id = aws_route53_resolver_endpoint.outbound.id

  target_ip {
    ip   = local.dns_ip
    port = 53
  }
  tags = { Name = "rule-corp" }
}

# Ruling P21: the first tag-checked change on each new Resolver item waits 20 seconds after its create.
resource "time_sleep" "resolver_tags" {
  create_duration = "20s"
  depends_on = [
    aws_route53_resolver_rule.corp,
    aws_route53_resolver_firewall_domain_list.blocked,
    aws_route53_resolver_firewall_rule_group.lab,
    aws_route53_resolver_query_log_config.lab,
  ]
}

resource "aws_route53_resolver_rule_association" "corp" {
  name             = "lab-${var.lab_id}-corp"
  resolver_rule_id = aws_route53_resolver_rule.corp.id
  vpc_id           = aws_vpc.lab.id
  depends_on       = [time_sleep.resolver_tags]
}

resource "aws_route53_zone" "cloud" {
  name          = local.cloud_domain
  force_destroy = true

  vpc {
    vpc_id     = aws_vpc.lab.id
    vpc_region = var.region
  }
  tags = { Name = "zone-cloud" }
}

resource "aws_route53_record" "app" {
  zone_id = aws_route53_zone.cloud.zone_id
  name    = "app.${local.cloud_domain}"
  type    = "A"
  ttl     = 60
  records = [aws_instance.cloud.private_ip]
}
