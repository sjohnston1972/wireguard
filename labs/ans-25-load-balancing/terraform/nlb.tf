# nlb.tf
#
# Plain English: lab 25's internet-facing Network Load Balancer, in
# snet-public-1 on its own Elastic IP (eip-nlb: the address never changes,
# which is what an NLB is chosen for). It has a security group of its own
# (TLS 443 and TCP 8080 from the internet), so the web instances can admit it
# by reference. TLS on 443 ends with the same imported certificate as the
# ALB and forwards plain TCP 80 to vm-blue. TCP on 8080 passes straight
# through to vm-green on port 80 with a proxy protocol v2 header in front,
# carrying the caller's own address: vm-green's simple web server does not
# expect that header, which is a Thing to try.

resource "aws_security_group" "nlb" {
  name        = "lab-nlb"
  description = "The NLB: TLS 443 and TCP 8080 from the internet, HTTP on to the web instances"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-nlb" }
}

resource "aws_vpc_security_group_ingress_rule" "nlb_tls" {
  security_group_id = aws_security_group.nlb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_ingress_rule" "nlb_pp" {
  security_group_id = aws_security_group.nlb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 8080
  to_port           = 8080
}

resource "aws_vpc_security_group_egress_rule" "nlb_to_web" {
  security_group_id            = aws_security_group.nlb.id
  referenced_security_group_id = aws_security_group.web.id
  ip_protocol                  = "tcp"
  from_port                    = 80
  to_port                      = 80
}

resource "aws_lb" "nlb" {
  name                       = "nlb-${var.name_prefix}"
  internal                   = false
  load_balancer_type         = "network"
  security_groups            = [aws_security_group.nlb.id]
  enable_deletion_protection = false
  tags                       = { Name = "nlb-app" }

  subnet_mapping {
    subnet_id     = aws_subnet.public[0].id
    allocation_id = aws_eip.nlb.id
  }

  depends_on = [aws_internet_gateway.lab, aws_route_table_association.public, aws_route.public_internet]
}

resource "aws_lb_target_group" "web" {
  name     = "tgn-${var.name_prefix}-web"
  port     = 80
  protocol = "TCP"
  vpc_id   = aws_vpc.lab.id
  tags     = { Name = "tgn-web" }
}

resource "aws_lb_target_group" "pp" {
  name              = "tgn-${var.name_prefix}-pp"
  port              = 80
  protocol          = "TCP"
  vpc_id            = aws_vpc.lab.id
  proxy_protocol_v2 = true
  tags              = { Name = "tgn-pp" }
}

resource "aws_lb_target_group_attachment" "nlb_web" {
  target_group_arn = aws_lb_target_group.web.arn
  target_id        = aws_instance.blue.id
  port             = 80
}

resource "aws_lb_target_group_attachment" "nlb_pp" {
  target_group_arn = aws_lb_target_group.pp.arn
  target_id        = aws_instance.green.id
  port             = 80
}

resource "aws_lb_listener" "tls" {
  load_balancer_arn = aws_lb.nlb.arn
  port              = 443
  protocol          = "TLS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate.app.arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
  tags = { Name = "listener-tls" }
}

resource "aws_lb_listener" "pp" {
  load_balancer_arn = aws_lb.nlb.arn
  port              = 8080
  protocol          = "TCP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.pp.arn
  }
  tags = { Name = "listener-pp" }
}
