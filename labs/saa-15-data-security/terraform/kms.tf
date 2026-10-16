# kms.tf
#
# Plain English: lab 15's customer managed key, alias/lab-<id>-data, which
# encrypts the lab's bucket. Its key policy gives the account (its root)
# every KMS action, so IAM policies can grant use of it and it can always be
# deleted (the scope check refuses one without that). Deleting waits 7 days,
# at no charge. Automatic rotation stays off at deploy (a tag-checked change
# right after the create; ruling A73): switch it on by hand.

resource "aws_kms_key" "data" {
  description             = "lab ${var.lab_id}, encrypts the lab bucket"
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
  name          = "alias/lab-${var.lab_id}-data"
  target_key_id = aws_kms_key.data.key_id
}
