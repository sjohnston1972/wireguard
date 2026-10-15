# compute.tf
#
# Plain English: lab 04's instance, vm-data (t4g.nano), with a 1 GiB gp3
# data volume (the backup plan's selection) mounted at /data, and a snapshot
# of that volume taken at deploy, to restore from. The instance tags its
# volumes at launch with volume_tags = var.tags (wg-admin-labs refuses a
# launch whose volume carries no lab tag). The provider applies volume_tags
# to every attached volume, so the data volume carries exactly the same tags
# (the provider's default_tags, nothing of its own) and neither resource
# undoes the other. The snapshot waits three minutes after the attachment,
# so cloud-init has formatted, mounted and written /data/first-write.txt first
# (the time provider is hashicorp/time, resolved without a required_providers
# entry because the AWS template's versions.tf is copied unchanged).

resource "aws_instance" "data" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.nano"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.vms.id]
  user_data = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    runcmd = [
      "for i in $(seq 1 60); do [ -e /dev/sdf ] && break; sleep 5; done",
      "blkid /dev/sdf || mkfs.xfs /dev/sdf",
      "mkdir -p /data",
      "mount /dev/sdf /data",
      "grep -q ' /data ' /etc/fstab || echo '/dev/sdf /data xfs defaults,nofail 0 2' >> /etc/fstab",
      "date -Is > /data/first-write.txt",
    ]
  }))}"

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size = 8
    volume_type = "gp3"
  }
  volume_tags = var.tags
  tags        = { Name = "vm-data" }
  depends_on  = [aws_vpc_endpoint.s3]
}

resource "aws_ebs_volume" "data" {
  availability_zone = local.azs[0]
  size              = 1
  type              = "gp3"
}

resource "aws_volume_attachment" "data" {
  device_name                    = "/dev/sdf"
  volume_id                      = aws_ebs_volume.data.id
  instance_id                    = aws_instance.data.id
  stop_instance_before_detaching = true
}

resource "time_sleep" "first_write" {
  create_duration = "180s"
  depends_on      = [aws_instance.data, aws_volume_attachment.data]
}

resource "aws_ebs_snapshot" "data" {
  volume_id   = aws_ebs_volume.data.id
  description = "Lab soa-04: the data volume as it was at deploy"
  tags        = { Name = "snap-data" }
  depends_on  = [time_sleep.first_write]
}
