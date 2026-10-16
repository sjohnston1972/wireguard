# ami.tf
#
# Plain English: lab 16's image in Ireland: Amazon Linux 2023 (arm64), the
# image London runs, copied from London so a DR launch never depends on
# London (ruling P4: a copy of AWS's own public image, named lab-<id>-*,
# which the safety net also finds by name, with its snapshot). The copy
# takes a few minutes.

resource "aws_ami_copy" "dr" {
  provider          = aws.secondary
  name              = "lab-${var.lab_id}-al2023-${var.name_prefix}"
  description       = "lab ${var.lab_id}: Amazon Linux 2023 (arm64) from London, for a DR launch in Ireland"
  source_ami_id     = data.aws_ssm_parameter.al2023_arm64.insecure_value
  source_ami_region = var.region
  tags              = { Name = "ami-dr" }
}
