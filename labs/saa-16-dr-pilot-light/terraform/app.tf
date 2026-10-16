# app.tf
#
# Plain English: lab 16's app in London, vm-app (t4g.nano), serving a page
# that says where it runs, and the alarm that decides failover:
# lab-<id>-app-down fires when the instance's status checks fail for two
# minutes, or when it stops reporting at all (missing data counts as failing),
# which is what stopping or losing the instance looks like.

locals {
  app_unit = join("\n", [
    "[Unit]",
    "Description=Lab 16 app page on port 80 (London, primary)",
    "After=network-online.target",
    "[Service]",
    "ExecStartPre=/bin/sh -c 'mkdir -p /srv/www && echo \"app in London (primary)\" > /srv/www/index.html'",
    "ExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www",
    "Restart=always",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])
  app_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [{ path = "/etc/systemd/system/lab-app.service", permissions = "0644", content = local.app_unit }]
    runcmd      = ["systemctl daemon-reload", "systemctl enable --now lab-app.service"]
  }))}"
}

resource "aws_instance" "app" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.vms.id]
  user_data              = local.app_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-app" })
  tags        = { Name = "vm-app" }
  depends_on  = [aws_vpc_endpoint.s3]
}

resource "aws_cloudwatch_metric_alarm" "app_down" {
  alarm_name          = "lab-${var.lab_id}-app-down"
  alarm_description   = "lab ${var.lab_id}: the London app's status checks fail, or it stops reporting"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "breaching"
  dimensions          = { InstanceId = aws_instance.app.id }
  tags                = { Name = "alarm-app-down" }
}
