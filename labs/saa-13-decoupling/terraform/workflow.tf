# workflow.tf
#
# Plain English: lab 13's workflow, lab-<id>-orders (Step Functions,
# standard). Validate calls the function lab-<id>-validate (retried twice on
# a Lambda service error); an order it refuses ends in Rejected; a valid one
# is published to the lab's topic, which fans it out. The definition names
# only the lab's own function and topic, known at plan (ruling P14). The
# function logs to /cloudlabs/<id>/validate (ruling A56); the workflow runs
# as lab-<id>-sfn, allowed only to call that function and publish to that
# topic.

locals {
  validate_arn = "arn:${data.aws_partition.current.partition}:lambda:${var.region}:${local.account}:function:lab-${var.lab_id}-validate"
  workflow_arn = "arn:${data.aws_partition.current.partition}:states:${var.region}:${local.account}:stateMachine:lab-${var.lab_id}-orders"
}

resource "aws_cloudwatch_log_group" "validate" {
  name              = "/cloudlabs/${var.lab_id}/validate"
  retention_in_days = 1
}

resource "aws_iam_role" "validate" {
  name                 = "lab-${var.lab_id}-validate"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "validate_logs" {
  role       = aws_iam_role.validate.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "archive_file" "validate" {
  type        = "zip"
  source_file = "${path.module}/lambda/validate.py"
  output_path = "${path.module}/.terraform/validate.zip"
}

resource "aws_lambda_function" "validate" {
  function_name    = "lab-${var.lab_id}-validate"
  role             = aws_iam_role.validate.arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = "validate.handler"
  filename         = data.archive_file.validate.output_path
  source_code_hash = data.archive_file.validate.output_base64sha256
  memory_size      = 128
  timeout          = 10
  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.validate.name
  }
  tags       = { Name = "fn-validate" }
  depends_on = [aws_iam_role_policy_attachment.validate_logs]
}

resource "aws_iam_role" "sfn" {
  name                 = "lab-${var.lab_id}-sfn"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "states.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_policy" "sfn" {
  name = "lab-${var.lab_id}-sfn"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "Validate", Effect = "Allow", Action = "lambda:InvokeFunction", Resource = [local.validate_arn, "${local.validate_arn}:*"] },
      { Sid = "Publish", Effect = "Allow", Action = "sns:Publish", Resource = local.topic_arn },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "sfn" {
  role       = aws_iam_role.sfn.name
  policy_arn = aws_iam_policy.sfn.arn
}

resource "aws_sfn_state_machine" "orders" {
  name     = "lab-${var.lab_id}-orders"
  type     = "STANDARD"
  role_arn = aws_iam_role.sfn.arn
  definition = jsonencode({
    Comment = "lab ${var.lab_id}: validate an order, then fan it out"
    StartAt = "Validate"
    States = {
      Validate = {
        Type       = "Task"
        Resource   = "arn:aws:states:::lambda:invoke"
        Parameters = { FunctionName = local.validate_arn, "Payload.$" = "$" }
        OutputPath = "$.Payload"
        Retry      = [{ ErrorEquals = ["Lambda.ServiceException", "Lambda.TooManyRequestsException"], MaxAttempts = 2, IntervalSeconds = 2, BackoffRate = 2 }]
        Catch      = [{ ErrorEquals = ["States.ALL"], Next = "Rejected" }]
        Next       = "Publish"
      }
      Publish = {
        Type       = "Task"
        Resource   = "arn:aws:states:::sns:publish"
        Parameters = { TopicArn = local.topic_arn, "Message.$" = "$" }
        End        = true
      }
      Rejected = { Type = "Fail", Error = "OrderRejected", Cause = "the order did not validate" }
    }
  })
  tags       = { Name = "sfn-orders" }
  depends_on = [aws_iam_role_policy_attachment.sfn, aws_lambda_function.validate]
}
