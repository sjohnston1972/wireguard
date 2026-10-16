# kms.tf
#
# Plain English: lab 07's customer managed key, alias/lab-<id>-data, which
# encrypts the lab's secret. Its key policy gives the account (its root) every
# KMS action, which is what lets IAM policies (ann's, the rotation role's)
# grant use of the key; the scope check refuses a key policy without it, so
# the key can always be deleted. Deleting waits the shortest window AWS
# allows, 7 days, at no charge. Automatic rotation is left off here (a change
# IAM would judge by a tag that may not be readable yet, ruling P15): switch it
# on by hand (Things to try).

locals {
  key_alias = "alias/lab-${var.lab_id}-data"
}

resource "aws_kms_key" "data" {
  description             = "lab ${var.lab_id}, encrypts the lab secret"
  deletion_window_in_days = 7
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "TheAccountAndItsIamPolicies", Effect = "Allow", Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }, Action = "kms:*", Resource = "*" },
    ]
  })
  tags = { Name = "key-data" }
}

resource "aws_kms_alias" "data" {
  name          = local.key_alias
  target_key_id = aws_kms_key.data.key_id
}
