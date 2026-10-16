# efs.tf
#
# Plain English: lab 14's file system, efs-shared: EFS Standard, encrypted,
# bursting throughput (never provisioned: it bills by the hour), and no
# lifecycle policy at deploy (setting one is a tag-checked change straight
# after the create; ruling P11): a Thing to try. A mount target in each
# private subnet admits NFS (TCP 2049) only from the lab instances. A
# 20-second wait lets the file system's tags reach IAM before the mount
# targets, which IAM judges by them (ruling P11). EFS's service-linked role is
# made ahead by the bootstrap (ruling P10).

resource "aws_security_group" "efs" {
  name        = "lab-efs"
  description = "NFS from the lab instances"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-efs" }
}

resource "aws_vpc_security_group_ingress_rule" "efs_nfs" {
  security_group_id            = aws_security_group.efs.id
  referenced_security_group_id = aws_security_group.vms.id
  ip_protocol                  = "tcp"
  from_port                    = 2049
  to_port                      = 2049
}

resource "aws_efs_file_system" "shared" {
  creation_token   = "lab-${var.lab_id}-${var.name_prefix}"
  encrypted        = true
  performance_mode = "generalPurpose"
  throughput_mode  = "bursting"
  tags             = { Name = "efs-shared" }
}

resource "time_sleep" "efs_tags" {
  create_duration = "20s"
  depends_on      = [aws_efs_file_system.shared]
}

resource "aws_efs_mount_target" "shared" {
  count           = 2
  file_system_id  = aws_efs_file_system.shared.id
  subnet_id       = aws_subnet.private[count.index].id
  security_groups = [aws_security_group.efs.id]
  depends_on      = [time_sleep.efs_tags]
}
