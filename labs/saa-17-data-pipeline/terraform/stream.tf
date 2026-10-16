# stream.tf
#
# Plain English: lab 17's ingestion. The stream lab-<id>-events: one
# provisioned shard (rule size), a day's retention, deletable with any
# consumers (rule lingering; ruling P15). The producer, lab-<id>-producer,
# logs to /cloudlabs/<id>/producer (ruling A56) and may only put records on
# that stream; the rule lab-<id>-every-minute calls it, allowed by a
# permission naming only that rule (ruling P13), after a 20-second wait for
# the function's tags (ruling P11).

locals {
  account    = data.aws_caller_identity.current.account_id
  stream_arn = "arn:${data.aws_partition.current.partition}:kinesis:${var.region}:${local.account}:stream/lab-${var.lab_id}-events"
}

resource "aws_kinesis_stream" "events" {
  name                      = "lab-${var.lab_id}-events"
  shard_count               = 1
  retention_period          = 24
  enforce_consumer_deletion = true
  stream_mode_details {
    stream_mode = "PROVISIONED"
  }
  tags = { Name = "stream-events" }
}

resource "aws_cloudwatch_log_group" "producer" {
  name              = "/cloudlabs/${var.lab_id}/producer"
  retention_in_days = 1
}

resource "aws_iam_role" "producer" {
  name                 = "lab-${var.lab_id}-producer"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "producer_logs" {
  role       = aws_iam_role.producer.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_policy" "producer" {
  name = "lab-${var.lab_id}-producer"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Sid = "LabStream", Effect = "Allow", Action = ["kinesis:PutRecord", "kinesis:PutRecords"], Resource = local.stream_arn }]
  })
}

resource "aws_iam_role_policy_attachment" "producer" {
  role       = aws_iam_role.producer.name
  policy_arn = aws_iam_policy.producer.arn
}

data "archive_file" "producer" {
  type        = "zip"
  source_file = "${path.module}/lambda/producer.py"
  output_path = "${path.module}/.terraform/producer.zip"
}

resource "aws_lambda_function" "producer" {
  function_name    = "lab-${var.lab_id}-producer"
  role             = aws_iam_role.producer.arn
  runtime          = "python3.13"
  architectures    = ["arm64"]
  handler          = "producer.handler"
  filename         = data.archive_file.producer.output_path
  source_code_hash = data.archive_file.producer.output_base64sha256
  memory_size      = 128
  timeout          = 30
  environment {
    variables = { STREAM = aws_kinesis_stream.events.name }
  }
  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.producer.name
  }
  tags       = { Name = "fn-producer" }
  depends_on = [aws_iam_role_policy_attachment.producer_logs, aws_iam_role_policy_attachment.producer]
}

resource "time_sleep" "producer_tags" {
  create_duration = "20s"
  depends_on      = [aws_lambda_function.producer]
}

resource "aws_cloudwatch_event_rule" "every_minute" {
  name                = "lab-${var.lab_id}-every-minute"
  schedule_expression = "rate(1 minute)"
  tags                = { Name = "rule-every-minute" }
}

resource "aws_lambda_permission" "every_minute" {
  statement_id  = "EveryMinute"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.producer.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.every_minute.arn
  depends_on    = [time_sleep.producer_tags]
}

resource "aws_cloudwatch_event_target" "producer" {
  rule       = aws_cloudwatch_event_rule.every_minute.name
  target_id  = "producer"
  arn        = aws_lambda_function.producer.arn
  depends_on = [aws_lambda_permission.every_minute]
}
