# function.tf
#
# Plain English: lab 12's function, lab-<id>-api (Python 3.13 on arm64, 128 MB),
# logging to /cloudlabs/<id>/api for one day (ruling A56), running as
# lab-<id>-api under the lab boundary: allowed only to scan, read and write
# the lab's own table. API Gateway may invoke it only for the lab's own API
# (ruling P13), after a 20-second wait for the function's tags (ruling P11).

locals {
  table_arn = "arn:${data.aws_partition.current.partition}:dynamodb:${var.region}:${data.aws_caller_identity.current.account_id}:table/lab-${var.lab_id}-items"
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/cloudlabs/${var.lab_id}/api"
  retention_in_days = 1
}

resource "aws_iam_role" "api" {
  name                 = "lab-${var.lab_id}-api"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "api_logs" {
  role       = aws_iam_role.api.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_policy" "api" {
  name = "lab-${var.lab_id}-api"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Sid = "LabTable", Effect = "Allow", Action = ["dynamodb:Scan", "dynamodb:GetItem", "dynamodb:PutItem"], Resource = local.table_arn }]
  })
}

resource "aws_iam_role_policy_attachment" "api" {
  role       = aws_iam_role.api.name
  policy_arn = aws_iam_policy.api.arn
}

data "archive_file" "api" {
  type        = "zip"
  source_file = "${path.module}/lambda/api.py"
  output_path = "${path.module}/.terraform/api.zip"
}

resource "aws_lambda_function" "api" {
  function_name    = "lab-${var.lab_id}-api"
  role             = aws_iam_role.api.arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = "api.handler"
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256
  memory_size      = 128
  timeout          = 10
  environment {
    variables = { TABLE = aws_dynamodb_table.items.name }
  }
  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.api.name
  }
  tags       = { Name = "fn-api" }
  depends_on = [aws_iam_role_policy_attachment.api_logs, aws_iam_role_policy_attachment.api]
}

resource "time_sleep" "function_tags" {
  create_duration = "20s"
  depends_on      = [aws_lambda_function.api]
}

resource "aws_lambda_permission" "api" {
  statement_id  = "ApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.lab.execution_arn}/*/*"
  depends_on    = [time_sleep.function_tags]
}
