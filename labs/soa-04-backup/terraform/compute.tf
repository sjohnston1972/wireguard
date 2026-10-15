# compute.tf
#
# Plain English: lab 04's instance, vm-data (t4g.nano), with a 1 GiB gp3
# data volume tagged for the backup plan (cloudlabs-backup = daily) and
# mounted at /data, and a snapshot of that volume taken at deploy, to
# restore from. The instance's own root volume takes the lab's tags through
# root_block_device (instance-level volume tags would fight the separately attached data
# volume over its tags).

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
    tags        = merge(var.tags, { Name = "vm-data" })
  }
  tags       = { Name = "vm-data" }
  depends_on = [aws_vpc_endpoint.s3]
}

resource "aws_ebs_volume" "data" {
  availability_zone = local.azs[0]
  size              = 1
  type              = "gp3"
  tags              = { Name = "vol-data", "cloudlabs-backup" = "daily" }
}

resource "aws_volume_attachment" "data" {
  device_name                    = "/dev/sdf"
  volume_id                      = aws_ebs_volume.data.id
  instance_id                    = aws_instance.data.id
  stop_instance_before_detaching = true
}

resource "aws_ebs_snapshot" "data" {
  volume_id   = aws_ebs_volume.data.id
  description = "Lab soa-04: the data volume as it was at deploy"
  tags        = { Name = "snap-data" }
  depends_on  = [aws_volume_attachment.data]
}
