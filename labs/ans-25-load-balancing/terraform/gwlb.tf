# gwlb.tf
#
# Plain English: lab 25's Gateway Load Balancer, in snet-appliance, sending
# every packet it is given to vm-appliance wrapped in GENEVE (UDP 6081) and
# taking it back the same way. Its health check asks the appliance for HTTP
# on port 8080. An endpoint service, vpces-gwlb, offers it to this account
# only and accepts without asking (ruling P13); the lab's one GWLB endpoint,
# vpce-gwlb in snet-gwlbe, is the next hop that snet-inspected's routes
# point at. Tear-down removes the endpoint and the service before the load
# balancer, as AWS requires (ruling P23).

resource "aws_lb" "gwlb" {
  name                       = "gwlb-${var.name_prefix}"
  load_balancer_type         = "gateway"
  subnets                    = [aws_subnet.appliance.id]
  enable_deletion_protection = false
  tags                       = { Name = "gwlb-appliance" }
}

resource "aws_lb_target_group" "gwlb" {
  name        = "tgg-${var.name_prefix}"
  port        = 6081
  protocol    = "GENEVE"
  vpc_id      = aws_vpc.lab.id
  target_type = "instance"
  health_check {
    protocol            = "HTTP"
    port                = "8080"
    path                = "/"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 2
  }
  tags = { Name = "tgg-appliance" }
}

resource "aws_lb_target_group_attachment" "appliance" {
  target_group_arn = aws_lb_target_group.gwlb.arn
  target_id        = aws_instance.appliance.id
}

resource "aws_lb_listener" "gwlb" {
  load_balancer_arn = aws_lb.gwlb.arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.gwlb.arn
  }
  tags = { Name = "listener-gwlb" }
}

resource "aws_vpc_endpoint_service" "gwlb" {
  acceptance_required        = false
  gateway_load_balancer_arns = [aws_lb.gwlb.arn]
  allowed_principals         = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
  tags                       = { Name = "vpces-gwlb" }
}

resource "aws_vpc_endpoint" "gwlb" {
  vpc_id            = aws_vpc.lab.id
  service_name      = aws_vpc_endpoint_service.gwlb.service_name
  vpc_endpoint_type = "GatewayLoadBalancer"
  subnet_ids        = [aws_subnet.gwlbe.id]
  tags              = { Name = "vpce-gwlb" }
}
