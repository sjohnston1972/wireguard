# mirror.tf
#
# Plain English: lab 28's traffic mirroring pieces, ready for a session you
# make by hand (a Thing to try; a session is billed by the hour, so the lab
# never leaves one running). The target is vm-monitor's own network
# interface (ruling P17); the filter, mirror-filter-web, keeps only TCP port
# 80 inside the lab's slot, in both directions: requests arriving at port 80
# and replies leaving it. Mirrored packets reach vm-monitor wrapped in VXLAN
# (UDP 4789).

resource "aws_ec2_traffic_mirror_target" "monitor" {
  description          = "lab ${var.lab_id}: vm-monitor receives mirrored traffic"
  network_interface_id = aws_instance.monitor.primary_network_interface_id
  tags                 = { Name = "mirror-monitor" }
}

resource "aws_ec2_traffic_mirror_filter" "web" {
  description = "lab ${var.lab_id}: TCP port 80 inside the slot"
  tags        = { Name = "mirror-filter-web" }
}

resource "aws_ec2_traffic_mirror_filter_rule" "in" {
  traffic_mirror_filter_id = aws_ec2_traffic_mirror_filter.web.id
  description              = "requests to port 80"
  rule_number              = 100
  rule_action              = "accept"
  traffic_direction        = "ingress"
  protocol                 = 6
  source_cidr_block        = var.address_space
  destination_cidr_block   = var.address_space
  destination_port_range {
    from_port = 80
    to_port   = 80
  }
}

resource "aws_ec2_traffic_mirror_filter_rule" "out" {
  traffic_mirror_filter_id = aws_ec2_traffic_mirror_filter.web.id
  description              = "replies from port 80"
  rule_number              = 100
  rule_action              = "accept"
  traffic_direction        = "egress"
  protocol                 = 6
  source_cidr_block        = var.address_space
  destination_cidr_block   = var.address_space
  source_port_range {
    from_port = 80
    to_port   = 80
  }
}
