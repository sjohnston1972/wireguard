# web.tf
#
# Plain English: lab 08's web instance, vm-web (t4g.nano), in the app VPC
# (the template's vpc-lab, snet-private-1), with the MariaDB client, from
# which the database should answer and does not.

resource "aws_instance" "web" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.vms.id]
  user_data = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    runcmd = ["for i in 1 2 3 4 5; do dnf install -y mariadb105 && break; sleep 10; done"]
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
  volume_tags = merge(var.tags, { Name = "vm-web" })
  tags        = { Name = "vm-web" }
  depends_on  = [aws_vpc_endpoint.s3]
}
