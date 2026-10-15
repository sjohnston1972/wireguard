# backup.tf
#
# Plain English: AWS Backup in lab 04. A vault of the lab's own (removable
# with its recovery points: Unblock deletes them first), a daily plan whose
# recovery points carry the lab's tags and expire after a day, and a
# selection of the data volume, by its ARN and only while it carries this
# lab's tag, backed up by a role of the lab's own. (The data volume's tags
# are the root volume's: see compute.tf, so a tag cannot tell them apart.)

resource "aws_backup_vault" "lab" {
  name          = "lab-${var.lab_id}-vault"
  force_destroy = true
  tags          = { Name = "lab-vault" }
}

resource "aws_iam_role" "backup" {
  name                 = "lab-${var.lab_id}-backup"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "backup.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "backup_backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_iam_role_policy_attachment" "backup_restores" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores"
}

resource "aws_backup_plan" "daily" {
  name = "lab-${var.lab_id}-daily"
  rule {
    rule_name           = "daily"
    target_vault_name   = aws_backup_vault.lab.name
    schedule            = "cron(0 5 ? * * *)"
    start_window        = 60
    completion_window   = 120
    recovery_point_tags = var.tags
    lifecycle {
      delete_after = 1
    }
  }
  tags = { Name = "lab-daily" }
}

resource "aws_backup_selection" "data" {
  name         = "lab-${var.lab_id}-data"
  plan_id      = aws_backup_plan.daily.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = [aws_ebs_volume.data.arn]
  condition {
    string_equals {
      key   = "aws:ResourceTag/cloudlabs-lab"
      value = var.lab_id
    }
  }
}
