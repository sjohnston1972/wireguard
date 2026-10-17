# acl.tf
#
# Plain English: snet-svc's own network ACL, acl-svc. Everything may come in;
# going out, rule 90 denies everything to the client VPC (vpc-lab) before
# rule 100 allows everything else. THIS IS FAULT 2 (readme, What was
# broken): network ACLs are stateless, so vm-svc's replies to the client are
# dropped on the way out, while the health checks' replies (to snet-nlb)
# pass. Tear-down note (ruling A82): destroying the association hands
# snet-svc back to the VPC's default ACL, which the lab role may do.

resource "aws_network_acl" "svc" {
  vpc_id = aws_vpc.service.id
  tags   = { Name = "acl-svc" }
}

resource "aws_network_acl_association" "svc" {
  network_acl_id = aws_network_acl.svc.id
  subnet_id      = aws_subnet.svc.id
}

resource "aws_network_acl_rule" "in_all" {
  network_acl_id = aws_network_acl.svc.id
  rule_number    = 100
  egress         = false
  protocol       = "-1"
  rule_action    = "allow"
  cidr_block     = "0.0.0.0/0"
}

# FAULT 2: replies to the client VPC are denied before rule 100 allows everything out.
resource "aws_network_acl_rule" "out_deny_client" {
  network_acl_id = aws_network_acl.svc.id
  rule_number    = 90
  egress         = true
  protocol       = "-1"
  rule_action    = "deny"
  cidr_block     = local.vpc_cidr
}

resource "aws_network_acl_rule" "out_all" {
  network_acl_id = aws_network_acl.svc.id
  rule_number    = 100
  egress         = true
  protocol       = "-1"
  rule_action    = "allow"
  cidr_block     = "0.0.0.0/0"
}
