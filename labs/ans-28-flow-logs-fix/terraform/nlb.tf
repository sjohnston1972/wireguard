# nlb.tf
#
# Plain English: lab 28's internal Network Load Balancer, nlb-<name_prefix>,
# in snet-nlb, with no security group: TCP 80 to vm-svc. Its target group
# keeps client IP preservation on, so vm-svc sees each request coming from
# the client's own address in vpc-lab, not from the load balancer. Health
# checks still come from the load balancer's own addresses in snet-nlb.
# THIS IS HALF OF FAULT 1 (readme, What was broken): the other half is
# vm-svc's security group, in compute.tf.

resource "aws_lb" "svc" {
  name                       = "nlb-${var.name_prefix}"
  internal                   = true
  load_balancer_type         = "network"
  subnets                    = [aws_subnet.nlb.id]
  enable_deletion_protection = false
  tags                       = { Name = "nlb-svc" }
}

# FAULT 1 (with sg-svc): client IP preservation delivers client addresses, which sg-svc does not admit.
resource "aws_lb_target_group" "svc" {
  name               = "tg-${var.name_prefix}"
  port               = 80
  protocol           = "TCP"
  vpc_id             = aws_vpc.service.id
  preserve_client_ip = "true"
  tags               = { Name = "tg-svc" }
}

resource "aws_lb_target_group_attachment" "svc" {
  target_group_arn = aws_lb_target_group.svc.arn
  target_id        = aws_instance.svc.id
  port             = 80
}

resource "aws_lb_listener" "svc" {
  load_balancer_arn = aws_lb.svc.arn
  port              = 80
  protocol          = "TCP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.svc.arn
  }
  tags = { Name = "listener-svc" }
}
