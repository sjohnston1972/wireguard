# app.tf
#
# Plain English: lab 11's web and app tier. A launch template (Amazon Linux
# 2023, t4g.micro, IMDSv2, the lab's tags at launch) and an Auto Scaling group
# of 2 (up to 4) across the two private subnets, registered with the load
# balancer and replaced when it says unhealthy. Each instance installs the
# MariaDB and Valkey/Redis clients (through the S3 endpoint and the NAT
# gateway) and serves a page naming itself, its zone, and the database and
# cache it uses, so the group starts once both exist.

locals {
  app_page = join("\n", [
    "#!/bin/sh",
    "T=$(curl -s -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')",
    "md() { curl -s -H \"X-aws-ec2-metadata-token: $T\" http://169.254.169.254/latest/meta-data/$1; }",
    "mkdir -p /srv/www",
    "{ echo \"app instance $(md instance-id) in $(md placement/availability-zone)\"; echo 'database ${aws_db_instance.app.address}'; echo 'cache ${aws_elasticache_replication_group.app.primary_endpoint_address}'; } > /srv/www/index.html",
    "",
  ])
  app_unit = join("\n", [
    "[Unit]",
    "Description=Lab 11 app page on port 80",
    "After=network-online.target",
    "[Service]",
    "ExecStartPre=/usr/local/bin/lab-page",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  app_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [
      { path = "/usr/local/bin/lab-page", permissions = "0755", content = local.app_page },
      { path = "/etc/systemd/system/lab-app.service", permissions = "0644", content = local.app_unit },
    ]
    runcmd = ["systemctl daemon-reload", "systemctl enable --now lab-app.service", "for i in 1 2 3 4 5; do dnf install -y mariadb105 valkey && break; dnf install -y mariadb105 redis6 && break; sleep 20; done"]
  }))}"
}

resource "aws_launch_template" "app" {
  name                   = "lt-${var.name_prefix}"
  image_id               = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.micro"
  vpc_security_group_ids = [aws_security_group.vms.id]
  user_data              = base64encode(local.app_cloud_init)
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
    tags          = merge(var.tags, { Name = "vm-app" })
  }
  tag_specifications {
    resource_type = "volume"
    tags          = merge(var.tags, { Name = "vm-app" })
  }
  tag_specifications {
    resource_type = "network-interface"
    tags          = merge(var.tags, { Name = "vm-app" })
  }
  tags = { Name = "lt-app" }
}

resource "aws_autoscaling_group" "web" {
  name                      = "asg-${var.name_prefix}"
  min_size                  = 2
  max_size                  = 4
  desired_capacity          = 2
  vpc_zone_identifier       = aws_subnet.private[*].id
  target_group_arns         = [aws_lb_target_group.web.arn]
  health_check_type         = "ELB"
  health_check_grace_period = 180
  force_delete              = true
  wait_for_capacity_timeout = "10m"

  launch_template {
    id      = aws_launch_template.app.id
    version = aws_launch_template.app.latest_version
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
    value               = "vm-app"
    propagate_at_launch = true
  }
  depends_on = [aws_vpc_endpoint.s3, aws_lb_listener.http, aws_route.private_nat]
}
