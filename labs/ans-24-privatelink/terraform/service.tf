# service.tf
#
# Plain English: lab 24's endpoint service (ruling P13). vm-provider's page
# sits behind an internal Network Load Balancer, nlb-<name_prefix>, in both
# provider subnets, TCP 80, with client IP preservation off (vm-provider sees
# the load balancer's own address, which its security group admits). The
# endpoint service vpces-lab publishes the load balancer: only this
# account's root may connect, connections are accepted at once, and there is
# no private DNS name (that would need a public domain's TXT record), so the
# consumer names it in its own private zone instead.

resource "aws_lb" "provider" {
  name                       = "nlb-${var.name_prefix}"
  internal                   = true
  load_balancer_type         = "network"
  subnets                    = aws_subnet.provider[*].id
  enable_deletion_protection = false
  tags                       = { Name = "nlb-provider" }
}

resource "aws_lb_target_group" "provider" {
  name               = "tg-${var.name_prefix}"
  port               = 80
  protocol           = "TCP"
  vpc_id             = aws_vpc.provider.id
  target_type        = "instance"
  preserve_client_ip = "false"
  health_check {
    protocol            = "TCP"
    interval            = 10
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
  tags = { Name = "tg-provider" }
}

resource "aws_lb_target_group_attachment" "provider" {
  target_group_arn = aws_lb_target_group.provider.arn
  target_id        = aws_instance.provider.id
  port             = 80
}

resource "aws_lb_listener" "provider" {
  load_balancer_arn = aws_lb.provider.arn
  port              = 80
  protocol          = "TCP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.provider.arn
  }
  tags = { Name = "listener-tcp-80" }
}

resource "aws_vpc_endpoint_service" "lab" {
  acceptance_required        = false
  network_load_balancer_arns = [aws_lb.provider.arn]
  allowed_principals         = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
  tags                       = { Name = "vpces-lab" }
}
