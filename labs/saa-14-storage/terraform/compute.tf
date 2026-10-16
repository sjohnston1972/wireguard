# compute.tf
#
# Plain English: lab 14's instance, vm-storage (t4g.micro), with two extra
# block volumes in its zone: a 4 GiB gp3 (3,000 IOPS whatever its size) at
# /dev/sdf and a 4 GiB io2 with 100 provisioned IOPS (the least io2 takes) at
# /dev/sdg, left unformatted for the Things to try. At boot it installs fio
# and the EFS mount helper through the S3 endpoint (each five tries, 20 seconds
# apart; the mount helper first, so a missing fio cannot stop the mount) and mounts the lab's file system at /mnt/efs over TLS, retrying while
# a new mount target's name reaches DNS. The volumes carry only the provider's
# default tags and the instance tags its volumes with var.tags, the same set,
# so neither cycles (ruling A49). Both attachments stop the instance before
# detaching, so a volume a learner mounted cannot stick in "busy" at destroy
# (as lab 04).

locals {
  storage_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    runcmd = [
      "for i in 1 2 3 4 5; do dnf install -y amazon-efs-utils && break; sleep 20; done",
      "for i in 1 2 3 4 5; do dnf install -y fio && break; sleep 20; done",
      "mkdir -p /mnt/efs",
      "echo '${aws_efs_file_system.shared.id}:/ /mnt/efs efs _netdev,tls 0 0' >> /etc/fstab",
      "for i in $(seq 1 20); do mount -a && break; sleep 15; done",
    ]
  }))}"
}

resource "aws_instance" "storage" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.insecure_value
  instance_type          = "t4g.micro"
  subnet_id              = aws_subnet.private[0].id
  vpc_security_group_ids = [aws_security_group.vms.id]
  user_data              = local.storage_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = var.tags
  tags        = { Name = "vm-storage" }
  depends_on  = [aws_efs_mount_target.shared, aws_vpc_endpoint.s3]
}

resource "aws_ebs_volume" "gp3" {
  availability_zone = aws_subnet.private[0].availability_zone
  size              = 4
  type              = "gp3"
}

resource "aws_ebs_volume" "io2" {
  availability_zone = aws_subnet.private[0].availability_zone
  size              = 4
  type              = "io2"
  iops              = 100
}

resource "aws_volume_attachment" "gp3" {
  device_name                    = "/dev/sdf"
  volume_id                      = aws_ebs_volume.gp3.id
  instance_id                    = aws_instance.storage.id
  stop_instance_before_detaching = true
}

resource "aws_volume_attachment" "io2" {
  device_name                    = "/dev/sdg"
  volume_id                      = aws_ebs_volume.io2.id
  instance_id                    = aws_instance.storage.id
  stop_instance_before_detaching = true
}
