# alb.tf
#
# Plain English: lab 25's internet-facing Application Load Balancer, in both
# public subnets. HTTP on port 80 only redirects to HTTPS. HTTPS on port 443
# ends TLS with the imported certificate and forwards by weight: 80 in 100
# requests to the blue target group (vm-blue), 20 to green (vm-green); a
# listener rule sends every path under /green/ to green alone. The web
# instances admit port 80 only from the load balancers' security groups.

resource "aws_security_group" "alb" {
  name        = "lab-alb"
  description = "The ALB: HTTP and HTTPS from the internet, HTTP on to the web instances"
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

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "alb_to_web" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.web.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

resource "aws_lb" "alb" {
  name                       = "alb-${var.name_prefix}"
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = aws_subnet.public[*].id
  enable_deletion_protection = false
  tags                       = { Name = "alb-app" }

  # Internet-facing: the gateway and the public route exist first, and the load balancer goes before they do.
  depends_on = [aws_internet_gateway.lab, aws_route_table_association.public, aws_route.public_internet]
}

resource "aws_lb_target_group" "blue" {
  name                 = "tg-${var.name_prefix}-blue"
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
  tags = { Name = "tg-blue" }
}

resource "aws_lb_target_group" "green" {
  name                 = "tg-${var.name_prefix}-green"
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
  tags = { Name = "tg-green" }
}

resource "aws_lb_target_group_attachment" "blue" {
  target_group_arn = aws_lb_target_group.blue.arn
  target_id        = aws_instance.blue.id
  port             = 80
}

resource "aws_lb_target_group_attachment" "green" {
  target_group_arn = aws_lb_target_group.green.arn
  target_id        = aws_instance.green.id
  port             = 80
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.alb.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
  tags = { Name = "listener-http" }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.alb.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate.app.arn
  default_action {
    type = "forward"
    forward {
      target_group {
        arn    = aws_lb_target_group.blue.arn
        weight = 80
      }
      target_group {
        arn    = aws_lb_target_group.green.arn
        weight = 20
      }
    }
  }
  tags = { Name = "listener-https" }
}

resource "aws_lb_listener_rule" "green" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.green.arn
  }
  condition {
    path_pattern {
      values = ["/green/*"]
    }
  }
  tags = { Name = "rule-green" }
}
