# identity.tf
#
# Plain English: lab 07's console user, ann (lab-<id>-ann at /cloudlabs-lab/),
# held by the same permission boundary as every lab role. Her own policy
# allows EC2 and CloudFormation reads, the lab's key (by its alias) and the
# lab's secret; the boundary allows EC2, KMS and Secrets Manager but no
# CloudFormation, so the console shows her CloudFormation as not authorised:
# what she may do is where the two overlap. The aws provider generates her
# password (aws_iam_user_login_profile takes none; ruling P5), shown behind
# Show; she is never asked to change it, because the boundary allows her no
# IAM. force_destroy removes any key or MFA device made for her by hand
# (ruling P6). And the account's IAM Access Analyzer for external access
# (free; one per region per account, ruling P14).

resource "aws_iam_user" "ann" {
  name                 = "lab-${var.lab_id}-ann"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  force_destroy        = true
  tags                 = { Name = "user-ann" }
}

resource "aws_iam_user_login_profile" "ann" {
  user                    = aws_iam_user.ann.name
  password_length         = 20
  password_reset_required = false
}

resource "aws_iam_policy" "ann" {
  name = "lab-${var.lab_id}-ann"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "LookAround", Effect = "Allow", Action = ["ec2:Describe*", "cloudformation:ListStacks", "cloudformation:DescribeStacks", "kms:ListKeys", "kms:ListAliases", "secretsmanager:ListSecrets"], Resource = "*" },
      {
        Sid       = "LabKey"
        Effect    = "Allow"
        Action    = ["kms:DescribeKey", "kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"]
        Resource  = "*"
        Condition = { "ForAnyValue:StringEquals" = { "kms:ResourceAliases" = local.key_alias } }
      },
      { Sid = "LabSecret", Effect = "Allow", Action = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue"], Resource = "arn:aws:secretsmanager:${var.region}:${data.aws_caller_identity.current.account_id}:secret:lab-${var.lab_id}-*" },
    ]
  })
}

resource "aws_iam_user_policy_attachment" "ann" {
  user       = aws_iam_user.ann.name
  policy_arn = aws_iam_policy.ann.arn
}

resource "aws_accessanalyzer_analyzer" "account" {
  analyzer_name = "lab-${var.lab_id}-account"
  type          = "ACCOUNT"
  tags          = { Name = "analyzer-account" }
}
