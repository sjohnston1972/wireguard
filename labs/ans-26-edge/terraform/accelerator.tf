# accelerator.tf
#
# Plain English: lab 26's Global Accelerator, lab-<id>: two fixed anycast IPv4
# addresses announced from AWS's edge, a TCP listener on port 80, and two
# endpoint groups, London and Ireland, each holding that region's NLB at full
# weight. A caller enters AWS at the nearest edge and rides AWS's network to
# the nearest healthy group. Client IP preservation is off (ruling P9): with it
# on, Global Accelerator would make untagged network interfaces and a
# security group inside the lab's VPCs. The accelerator's API answers only
# in us-west-2; the default provider signs it there itself (ruling P9, V).

resource "aws_globalaccelerator_accelerator" "lab" {
  name            = "lab-${var.lab_id}"
  ip_address_type = "IPV4"
  enabled         = true
  attributes {
    flow_logs_enabled = false
  }
  tags = { Name = "ga-lab" }
}

resource "aws_globalaccelerator_listener" "http" {
  accelerator_arn = aws_globalaccelerator_accelerator.lab.arn
  client_affinity = "NONE"
  protocol        = "TCP"
  port_range {
    from_port = 80
    to_port   = 80
  }
}

resource "aws_globalaccelerator_endpoint_group" "london" {
  listener_arn            = aws_globalaccelerator_listener.http.arn
  endpoint_group_region   = var.region
  health_check_protocol   = "TCP"
  health_check_port       = 80
  traffic_dial_percentage = 100
  endpoint_configuration {
    endpoint_id                    = aws_lb.london.arn
    weight                         = 100
    client_ip_preservation_enabled = false
  }
}

resource "aws_globalaccelerator_endpoint_group" "ireland" {
  listener_arn            = aws_globalaccelerator_listener.http.arn
  endpoint_group_region   = var.secondary_region
  health_check_protocol   = "TCP"
  health_check_port       = 80
  traffic_dial_percentage = 100
  endpoint_configuration {
    endpoint_id                    = aws_lb.ireland.arn
    weight                         = 100
    client_ip_preservation_enabled = false
  }
}
