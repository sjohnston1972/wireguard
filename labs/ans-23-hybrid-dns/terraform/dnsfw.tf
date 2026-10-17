# dnsfw.tf
#
# Plain English: lab 23's DNS Firewall on the cloud VPC. A domain list,
# lab-<id>-blocked (example.com and every name under it), a rule group with
# one rule that answers NXDOMAIN ("no such name") for anything on the list,
# and the group's association with vpc-lab. Only vpc-lab is filtered: the
# data centre's VPC asks Amazon's resolver unfiltered, which is the
# comparison the readme suggests. Mutation protection is off, so tear-down
# can remove the association.

resource "aws_route53_resolver_firewall_domain_list" "blocked" {
  name    = "lab-${var.lab_id}-blocked"
  domains = ["example.com.", "*.example.com."]
  tags    = { Name = "dnsfw-blocked" }
}

resource "aws_route53_resolver_firewall_rule_group" "lab" {
  name = "lab-${var.lab_id}-dnsfw"
  tags = { Name = "dnsfw-group" }
}

resource "aws_route53_resolver_firewall_rule" "block" {
  name                    = "block"
  action                  = "BLOCK"
  block_response          = "NXDOMAIN"
  firewall_domain_list_id = aws_route53_resolver_firewall_domain_list.blocked.id
  firewall_rule_group_id  = aws_route53_resolver_firewall_rule_group.lab.id
  priority                = 100
  depends_on              = [time_sleep.resolver_tags]
}

resource "aws_route53_resolver_firewall_rule_group_association" "lab" {
  name                   = "lab-${var.lab_id}-dnsfw"
  firewall_rule_group_id = aws_route53_resolver_firewall_rule_group.lab.id
  vpc_id                 = aws_vpc.lab.id
  priority               = 101
  mutation_protection    = "DISABLED"
  tags                   = { Name = "dnsfw-vpc-lab" }
  depends_on             = [aws_route53_resolver_firewall_rule.block]
}
