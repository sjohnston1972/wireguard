# alb.tf
#
# Plain English: lab 03's internet-facing Application Load Balancer. It takes
# HTTP on port 80 from anywhere and sends it to the group's instances, which
# admit port 80 only from the load balancer. Health checks every 15 seconds
# decide which instances get traffic; deregistration waits 30 seconds.

resource "aws_security_group" "alb" {
  name        = "lab-alb"
  description = "The load balancer: HTTP from the internet, HTTP on to the instances"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-alb" }
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_egress_rule" "alb_to_vms" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.vms.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

resource "aws_vpc_security_group_ingress_rule" "vms_http_alb" {
  security_group_id            = aws_security_group.vms.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

resource "aws_lb" "web" {
  name                       = "alb-${var.name_prefix}"
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  enable_deletion_protection = false
  tags                       = { Name = "alb-web" }

  # The load balancer needs the internet gateway attached and the public route in place before it is created,
  # and must be gone before the gateway detaches.
  depends_on = [aws_internet_gateway.lab, aws_route_table_association.public]
}

resource "aws_lb_target_group" "web" {
  name                 = "tg-${var.name_prefix}"
  port                 = 80
  protocol             = "HTTP"
  vpc_id               = aws_vpc.lab.id
  deregistration_delay = 30
  health_check {
    path                = "/"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 2
    matcher             = "200"
  }
  tags = { Name = "tg-web" }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.web.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
  tags = { Name = "listener-http" }
}
