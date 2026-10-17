# firewall.tf
#
# Plain English: lab 27's AWS Network Firewall, lab-<id>, with one endpoint
# in snet-insp-firewall (one zone keeps it to one endpoint-hour, about 30p;
# ruling P16), and no delete, subnet-change or policy-change protection, so
# tear-down can always remove it. Its policy, lab-<id>-policy, runs two rule
# groups in order. The stateless group drops ping (ICMP) from spoke B to
# spoke A and hands everything else to the stateful engine. The stateful
# group is a domain allow-list: HTTP host names and TLS server names ending
# .amazonaws.com, .amazon.com or .ubuntu.com, from the slot (HOME_NET) to
# anywhere outside it, pass. The rules are evaluated in strict order, and
# whatever no rule passes is dropped once its connection is set up, and
# logged as an alert (the lab's bucket, logs.tf). A 20-second wait lets the
# firewall's tags reach the permission check before its logging is set
# (ruling P21).

resource "aws_networkfirewall_rule_group" "stateless" {
  name        = "lab-${var.lab_id}-stateless"
  description = "Drop ping from spoke B to spoke A; send everything else to the stateful engine"
  type        = "STATELESS"
  capacity    = 10
  rule_group {
    rules_source {
      stateless_rules_and_custom_actions {
        stateless_rule {
          priority = 1
          rule_definition {
            actions = ["aws:drop"]
            match_attributes {
              protocols = [1]
              source {
                address_definition = local.spoke_b_cidr
              }
              destination {
                address_definition = local.vpc_cidr
              }
            }
          }
        }
        stateless_rule {
          priority = 10
          rule_definition {
            actions = ["aws:forward_to_sfe"]
            match_attributes {
              source {
                address_definition = "0.0.0.0/0"
              }
              destination {
                address_definition = "0.0.0.0/0"
              }
            }
          }
        }
      }
    }
  }
  tags = { Name = "nfw-stateless" }
}

resource "aws_networkfirewall_rule_group" "domains" {
  name        = "lab-${var.lab_id}-domains"
  description = "Allow HTTP and TLS only to AWS and Ubuntu domains"
  type        = "STATEFUL"
  capacity    = 100
  rule_group {
    rule_variables {
      ip_sets {
        key = "HOME_NET"
        ip_set {
          definition = [var.address_space]
        }
      }
    }
    rules_source {
      rules_source_list {
        generated_rules_type = "ALLOWLIST"
        target_types         = ["HTTP_HOST", "TLS_SNI"]
        targets              = [".amazonaws.com", ".amazon.com", ".ubuntu.com"]
      }
    }
    stateful_rule_options {
      rule_order = "STRICT_ORDER"
    }
  }
  tags = { Name = "nfw-domains" }
}

resource "aws_networkfirewall_firewall_policy" "lab" {
  name        = "lab-${var.lab_id}-policy"
  description = "lab ${var.lab_id}: the stateless group, then the domain allow-list, then drop established"
  firewall_policy {
    stateless_default_actions          = ["aws:forward_to_sfe"]
    stateless_fragment_default_actions = ["aws:forward_to_sfe"]
    stateful_default_actions           = ["aws:drop_established", "aws:alert_established"]
    stateless_rule_group_reference {
      priority     = 1
      resource_arn = aws_networkfirewall_rule_group.stateless.arn
    }
    stateful_engine_options {
      rule_order = "STRICT_ORDER"
    }
    stateful_rule_group_reference {
      priority     = 1
      resource_arn = aws_networkfirewall_rule_group.domains.arn
    }
  }
  tags = { Name = "nfw-policy" }
}

resource "aws_networkfirewall_firewall" "lab" {
  name                              = "lab-${var.lab_id}"
  description                       = "lab ${var.lab_id}: inspects the spokes through the transit gateway"
  firewall_policy_arn               = aws_networkfirewall_firewall_policy.lab.arn
  vpc_id                            = aws_vpc.inspection.id
  delete_protection                 = false
  subnet_change_protection          = false
  firewall_policy_change_protection = false
  subnet_mapping {
    subnet_id = aws_subnet.insp_firewall.id
  }
  tags = { Name = "nfw-lab" }
}

resource "time_sleep" "firewall_tags" {
  create_duration = "20s"
  depends_on      = [aws_networkfirewall_firewall.lab]
}
