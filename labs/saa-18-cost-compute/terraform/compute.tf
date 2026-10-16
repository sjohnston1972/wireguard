# compute.tf
#
# Plain English: lab 18's group, asg-<prefix>, three instances (up to four)
# across the two private subnets (ruling P9). The first is always an
# On-Demand t4g.micro (the base); every one above it is Spot, chosen by
# AWS for the lowest price and the most spare capacity among t4g.micro,
# t4g.small and t3.micro, and replaced early when AWS warns it will take one
# back (capacity rebalancing). Two launch templates: Graviton (arm64) and
# x86_64, each Amazon Linux 2023 from AWS's public parameter, tagging
# instance, volume and interface at launch. Each instance serves a page
# naming its type, purchase option, architecture and zone (written by a
# script, because systemd would expand the shell variables in a unit line).
# The apply does not wait for the group to fill: a Spot shortfall never
# fails it.

data "aws_ssm_parameter" "al2023_x86" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

locals {
  mixed_page = join("\n", [
    "#!/bin/sh",
    "T=$(curl -s -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')",
    "mkdir -p /srv/www",
    "for k in instance-type instance-life-cycle placement/availability-zone; do curl -s -H \"X-aws-ec2-metadata-token: $T\" http://169.254.169.254/latest/meta-data/$k; echo; done > /srv/www/index.html",
    "uname -m >> /srv/www/index.html",
    "",
  ])
  mixed_unit = join("\n", [
    "[Unit]",
    "Description=Lab 18 page: this instance's type, purchase option, architecture and zone",
    "After=network-online.target",
    "[Service]",
    "ExecStartPre=/usr/local/bin/lab-page",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  mixed_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [
      { path = "/usr/local/bin/lab-page", permissions = "0755", content = local.mixed_page },
      { path = "/etc/systemd/system/lab-page.service", permissions = "0644", content = local.mixed_unit },
    ]
    runcmd = ["systemctl daemon-reload", "systemctl enable --now lab-page.service"]
  }))}"
  templates = {
    arm = data.aws_ssm_parameter.al2023_arm64.insecure_value
    x86 = data.aws_ssm_parameter.al2023_x86.insecure_value
  }
}

resource "aws_launch_template" "mixed" {
  for_each               = local.templates
  name                   = "lt-${var.name_prefix}-${each.key}"
  image_id               = each.value
  instance_type          = each.key == "arm" ? "t4g.micro" : "t3.micro"
  vpc_security_group_ids = [aws_security_group.vms.id]
  user_data              = base64encode(local.mixed_cloud_init)
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
    tags          = merge(var.tags, { Name = "vm-${each.key}" })
  }
  tag_specifications {
    resource_type = "volume"
    tags          = merge(var.tags, { Name = "vm-${each.key}" })
  }
  tag_specifications {
    resource_type = "network-interface"
    tags          = merge(var.tags, { Name = "vm-${each.key}" })
  }
  tags = { Name = "lt-${each.key}" }
}

resource "aws_autoscaling_group" "mixed" {
  name                      = "asg-${var.name_prefix}"
  min_size                  = 3
  max_size                  = 4
  desired_capacity          = 3
  vpc_zone_identifier       = aws_subnet.private[*].id
  capacity_rebalance        = true
  force_delete              = true
  wait_for_capacity_timeout = "0"

  mixed_instances_policy {
    instances_distribution {
      on_demand_base_capacity                  = 1
      on_demand_percentage_above_base_capacity = 0
      spot_allocation_strategy                 = "price-capacity-optimized"
    }
    launch_template {
      launch_template_specification {
        launch_template_id = aws_launch_template.mixed["arm"].id
        version            = "$Latest"
      }
      override {
        instance_type = "t4g.micro"
      }
      override {
        instance_type = "t4g.small"
      }
      override {
        instance_type = "t3.micro"
        launch_template_specification {
          launch_template_id = aws_launch_template.mixed["x86"].id
          version            = "$Latest"
        }
      }
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
    value               = "vm-mixed"
    propagate_at_launch = true
  }
  depends_on = [aws_vpc_endpoint.s3]
}
