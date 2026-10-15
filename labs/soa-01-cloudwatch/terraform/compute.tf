# compute.tf
#
# Plain English: lab 01's instance, vm-app, and what it needs to report
# without any internet route: a role allowed to put metrics and logs
# (CloudWatchAgentServerPolicy, under the lab boundary), and interface
# endpoints for CloudWatch Logs and CloudWatch in one subnet. A small
# service, lab-app, writes a log line every 10 seconds, one in ten an ERROR,
# which the agent ships with memory and disk use.

resource "aws_iam_role" "vm" {
  name                 = "lab-${var.lab_id}-vm"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "vm_cloudwatch" {
  role       = aws_iam_role.vm.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

resource "aws_iam_instance_profile" "vm" {
  name = "lab-${var.lab_id}-vm"
  path = "/cloudlabs-lab/"
  role = aws_iam_role.vm.name
}

resource "aws_security_group" "endpoints" {
  name        = "lab-endpoints"
  description = "Interface endpoints: HTTPS from the lab VPC"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-endpoints" }
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_https" {
  security_group_id = aws_security_group.endpoints.id
  cidr_ipv4         = local.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = toset(["logs", "monitoring"])
  vpc_id              = aws_vpc.lab.id
  service_name        = "com.amazonaws.${var.region}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.private[0].id]
  security_group_ids  = [aws_security_group.endpoints.id]
  private_dns_enabled = true
  tags                = { Name = "vpce-${each.key}" }
}

locals {
  agent_config = jsonencode({
    agent = { metrics_collection_interval = 60 }
    metrics = {
      namespace         = "cloudlabs/${var.lab_id}"
      append_dimensions = { InstanceId = "$${aws:InstanceId}" }
      metrics_collected = {
        mem  = { measurement = ["mem_used_percent"] }
        disk = { measurement = ["used_percent"], resources = ["/"] }
      }
    }
    logs = { logs_collected = { files = { collect_list = [{ file_path = "/var/log/lab-app.log", log_group_name = "/cloudlabs/${var.lab_id}/app", log_stream_name = "{instance_id}" }] } } }
  })
  app_script = <<-EOT
    #!/bin/bash
    # One log line every 10 seconds; every tenth is an ERROR (lab 01's metric filter counts them).
    n=0
    while true; do
      n=$((n + 1))
      if [ $((n % 10)) -eq 0 ]; then echo "$(date -Is) ERROR payment service timed out (request $n)"; else echo "$(date -Is) INFO served request $n"; fi
      sleep 10
    done >> /var/log/lab-app.log
  EOT
  app_unit   = "[Unit]\nDescription=Lab 01 sample app log\nAfter=network-online.target\n[Service]\nExecStart=/usr/local/bin/lab-app.sh\nRestart=always\n[Install]\nWantedBy=multi-user.target\n"
}

resource "aws_instance" "app" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.micro"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.vms.id]
  iam_instance_profile   = aws_iam_instance_profile.vm.name
  monitoring             = true
  user_data = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    write_files = [
      { path = "/opt/aws/amazon-cloudwatch-agent/etc/lab.json", permissions = "0644", content = local.agent_config },
      { path = "/usr/local/bin/lab-app.sh", permissions = "0755", content = local.app_script },
      { path = "/etc/systemd/system/lab-app.service", permissions = "0644", content = local.app_unit },
    ]
    runcmd = [
      "dnf install -y amazon-cloudwatch-agent",
      "/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/lab.json",
      "systemctl daemon-reload",
      "systemctl enable --now lab-app.service",
    ]
  }))}"
  user_data_replace_on_change = false

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size = 8
    volume_type = "gp3"
  }
  volume_tags = merge(var.tags, { Name = "vm-app" })
  tags        = { Name = "vm-app" }
  depends_on  = [aws_vpc_endpoint.interface, aws_vpc_endpoint.s3, aws_cloudwatch_log_group.app]
}
