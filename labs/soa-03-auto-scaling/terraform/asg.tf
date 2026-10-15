# asg.tf
#
# Plain English: lab 03's instances. A launch template (Amazon Linux 2023,
# t4g.micro, IMDSv2, the lab's tags on instance, volume and network
# interface) and an Auto Scaling group of 2 to 4 across the two private
# subnets, registered with the ALB's target group and replaced when the ALB
# says unhealthy. Each instance serves a page naming itself and its zone
# with python3 (no packages to install). Scaling: target tracking at 50%
# CPU, a scheduled action back to two every evening, a launch lifecycle hook
# that holds new instances for 60 seconds, and rolling instance refresh when
# the template changes.

locals {
  web_unit = join("\n", [
    "[Unit]",
    "Description=Lab 03 web page (this instance's id and zone) on port 80",
    "After=network-online.target",
    "[Service]",
    "ExecStartPre=/bin/sh -c 'mkdir -p /srv/www && T=$(curl -s -X PUT http://169.254.169.254/latest/api/token -H \"X-aws-ec2-metadata-token-ttl-seconds: 300\") && for k in instance-id placement/availability-zone; do curl -s -H \"X-aws-ec2-metadata-token: $T\" http://169.254.169.254/latest/meta-data/$k; echo; done > /srv/www/index.html'",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  web_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [{ path = "/etc/systemd/system/lab-web.service", permissions = "0644", content = local.web_unit }]
    runcmd      = ["systemctl daemon-reload", "systemctl enable --now lab-web.service"]
  }))}"
}

resource "aws_launch_template" "web" {
  name                   = "lt-${var.name_prefix}"
  image_id               = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.micro"
  vpc_security_group_ids = [aws_security_group.vms.id]
  user_data              = base64encode(local.web_cloud_init)
  update_default_version = true

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 8
      volume_type           = "gp3"
      delete_on_termination = true
    }
  }
  tag_specifications {
    resource_type = "instance"
    tags          = merge(var.tags, { Name = "vm-web" })
  }
  tag_specifications {
    resource_type = "volume"
    tags          = merge(var.tags, { Name = "vm-web" })
  }
  tag_specifications {
    resource_type = "network-interface"
    tags          = merge(var.tags, { Name = "vm-web" })
  }
  tags = { Name = "lt-web" }
}

resource "aws_autoscaling_group" "web" {
  name                      = "asg-${var.name_prefix}"
  min_size                  = 2
  max_size                  = 4
  desired_capacity          = 2
  vpc_zone_identifier       = aws_subnet.private[*].id
  target_group_arns         = [aws_lb_target_group.web.arn]
  health_check_type         = "ELB"
  health_check_grace_period = 120
  force_delete              = true
  wait_for_capacity_timeout = "10m"

  launch_template {
    id      = aws_launch_template.web.id
    version = aws_launch_template.web.latest_version
  }
  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 50
    }
  }
  tag {
    key                 = "cloudlabs-lab"
    value               = var.lab_id
    propagate_at_launch = true
  }
  tag {
    key                 = "cloudlabs-session"
    value               = var.tags["cloudlabs-session"]
    propagate_at_launch = true
  }
  tag {
    key                 = "project"
    value               = var.tags["project"]
    propagate_at_launch = true
  }
  tag {
    key                 = "Name"
    value               = "vm-web"
    propagate_at_launch = true
  }
  depends_on = [aws_vpc_endpoint.s3, aws_lb_listener.http]
}

resource "aws_autoscaling_policy" "cpu" {
  name                   = "cpu-50"
  autoscaling_group_name = aws_autoscaling_group.web.name
  policy_type            = "TargetTrackingScaling"
  target_tracking_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ASGAverageCPUUtilization"
    }
    target_value = 50
  }
}

resource "aws_autoscaling_schedule" "evening" {
  scheduled_action_name  = "evening-back-to-two"
  autoscaling_group_name = aws_autoscaling_group.web.name
  recurrence             = "0 22 * * *"
  time_zone              = "Europe/London"
  min_size               = 2
  max_size               = 4
  desired_capacity       = 2
}

resource "aws_autoscaling_lifecycle_hook" "launch" {
  name                   = "launch-wait"
  autoscaling_group_name = aws_autoscaling_group.web.name
  lifecycle_transition   = "autoscaling:EC2_INSTANCE_LAUNCHING"
  heartbeat_timeout      = 60
  default_result         = "CONTINUE"
}
