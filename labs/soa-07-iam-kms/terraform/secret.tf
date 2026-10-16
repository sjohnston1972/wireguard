# secret.tf
#
# Plain English: lab 07's secret, lab-<id>-app-<name prefix> (a user name and
# password, encrypted with the lab's key), and a Lambda function,
# lab-<id>-rotate, that rotates it. Secrets Manager calls it in four steps:
# create the new version, set it where it is used, test it, make it current.
# This lab has no database, so "set" only logs; the other three are what any
# rotation does. It rotates once at deploy, then every 30 days, or when you
# press Rotate. The function has no VPC (it calls Secrets Manager's public
# endpoint), writes its log to /cloudlabs/<id>/rotate (one day; ruling A56)
# and runs as lab-<id>-rotate, under the lab boundary, allowed only this lab's
# secrets and key. A 20-second wait lets the new secret's and function's tags
# reach IAM before the first change it judges by them (ruling P15).

resource "random_password" "app" {
  length  = 24
  special = false
}

resource "aws_secretsmanager_secret" "app" {
  name                    = "lab-${var.lab_id}-app-${var.name_prefix}"
  description             = "lab ${var.lab_id}, an application database login"
  kms_key_id              = aws_kms_key.data.arn
  recovery_window_in_days = 0
  tags                    = { Name = "secret-app" }
}

resource "aws_iam_role" "rotate" {
  name                 = "lab-${var.lab_id}-rotate"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "rotate_logs" {
  role       = aws_iam_role.rotate.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_policy" "rotate" {
  name = "lab-${var.lab_id}-rotate"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "LabSecrets", Effect = "Allow", Action = ["secretsmanager:DescribeSecret", "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue", "secretsmanager:UpdateSecretVersionStage"], Resource = "arn:aws:secretsmanager:${var.region}:${data.aws_caller_identity.current.account_id}:secret:lab-${var.lab_id}-*" },
      { Sid = "NewPasswords", Effect = "Allow", Action = "secretsmanager:GetRandomPassword", Resource = "*" },
      {
        Sid       = "LabKey"
        Effect    = "Allow"
        Action    = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource  = "*"
        Condition = { "ForAnyValue:StringEquals" = { "kms:ResourceAliases" = local.key_alias } }
      },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "rotate" {
  role       = aws_iam_role.rotate.name
  policy_arn = aws_iam_policy.rotate.arn
}

resource "aws_cloudwatch_log_group" "rotate" {
  name              = "/cloudlabs/${var.lab_id}/rotate"
  retention_in_days = 1
}

data "archive_file" "rotate" {
  type        = "zip"
  source_file = "${path.module}/lambda/rotate.py"
  output_path = "${path.module}/.terraform/rotate.zip"
}

resource "aws_lambda_function" "rotate" {
  function_name    = "lab-${var.lab_id}-rotate"
  role             = aws_iam_role.rotate.arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = "rotate.handler"
  filename         = data.archive_file.rotate.output_path
  source_code_hash = data.archive_file.rotate.output_base64sha256
  memory_size      = 128
  timeout          = 30
  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.rotate.name
  }
  tags       = { Name = "fn-rotate" }
  depends_on = [aws_iam_role_policy_attachment.rotate, aws_iam_role_policy_attachment.rotate_logs]
}

# Ruling P15: the secret's and the function's tags reach IAM a few seconds after they are made.
resource "time_sleep" "tags" {
  create_duration = "20s"
  depends_on      = [aws_secretsmanager_secret.app, aws_lambda_function.rotate]
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id     = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({ username = "app", password = random_password.app.result })
  depends_on    = [time_sleep.tags]
  # Rotation writes new versions; this is only the first.
  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_lambda_permission" "secrets_manager" {
  statement_id  = "SecretsManagerRotation"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.rotate.function_name
  principal     = "secretsmanager.amazonaws.com"
  source_arn    = aws_secretsmanager_secret.app.arn
  depends_on    = [time_sleep.tags]
}

resource "aws_secretsmanager_secret_rotation" "app" {
  secret_id           = aws_secretsmanager_secret.app.id
  rotation_lambda_arn = aws_lambda_function.rotate.arn
  rotation_rules {
    automatically_after_days = 30
  }
  depends_on = [aws_secretsmanager_secret_version.app, aws_lambda_permission.secrets_manager]
}
