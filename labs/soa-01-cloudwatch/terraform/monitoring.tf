# monitoring.tf
#
# Plain English: what lab 01 watches with. The app log's group (kept one
# day), a metric filter counting ERROR lines, three alarms (CPU from EC2's
# own 1-minute metrics, app errors, memory from the agent) that notify an SNS
# topic with no subscribers until you add one, a dashboard, a saved Logs
# Insights query, and an EventBridge rule that sends vm-app's state changes
# to the same topic. Dashboards and query definitions cannot carry tags, so
# they are named lab-<id>-* (ruling A4).

resource "aws_cloudwatch_log_group" "app" {
  name              = "/cloudlabs/${var.lab_id}/app"
  retention_in_days = 1
}

resource "aws_cloudwatch_log_metric_filter" "errors" {
  name           = "lab-errors"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "ERROR"
  metric_transformation {
    name          = "AppErrors"
    namespace     = "cloudlabs/${var.lab_id}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_sns_topic" "alerts" {
  name = "lab-${var.lab_id}-alerts"
}

locals {
  # Known at plan (ruling P10: a resource policy is read for who it lets in, so it must be known before apply).
  alerts_arn = "arn:${data.aws_partition.current.partition}:sns:${var.region}:${data.aws_caller_identity.current.account_id}:lab-${var.lab_id}-alerts"
}

resource "aws_sns_topic_policy" "alerts" {
  arn = aws_sns_topic.alerts.arn
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "OwnerManages"
        Effect    = "Allow"
        Principal = { AWS = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root" }
        Action    = ["sns:GetTopicAttributes", "sns:SetTopicAttributes", "sns:Subscribe", "sns:ListSubscriptionsByTopic", "sns:Publish", "sns:DeleteTopic"]
        Resource  = local.alerts_arn
      },
      {
        Sid       = "EventsAndAlarmsOfThisAccount"
        Effect    = "Allow"
        Principal = { Service = ["events.amazonaws.com", "cloudwatch.amazonaws.com"] }
        Action    = "sns:Publish"
        Resource  = local.alerts_arn
        Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
      },
    ]
  })
}

resource "aws_cloudwatch_metric_alarm" "cpu_high" {
  alarm_name          = "lab-${var.lab_id}-cpu-high"
  alarm_description   = "vm-app's CPU above 70% for two minutes"
  namespace           = "AWS/EC2"
  metric_name         = "CPUUtilization"
  dimensions          = { InstanceId = aws_instance.app.id }
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 2
  threshold           = 70
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "app_errors" {
  alarm_name          = "lab-${var.lab_id}-app-errors"
  alarm_description   = "Five or more ERROR lines in a minute"
  namespace           = "cloudlabs/${var.lab_id}"
  metric_name         = "AppErrors"
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "memory_high" {
  alarm_name          = "lab-${var.lab_id}-memory-high"
  alarm_description   = "vm-app's memory above 80% for two minutes (from the agent)"
  namespace           = "cloudlabs/${var.lab_id}"
  metric_name         = "mem_used_percent"
  dimensions          = { InstanceId = aws_instance.app.id }
  statistic           = "Average"
  period              = 60
  evaluation_periods  = 2
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_dashboard" "overview" {
  dashboard_name = "lab-${var.lab_id}-overview"
  dashboard_body = jsonencode({
    widgets = [
      { type = "metric", x = 0, y = 0, width = 12, height = 6, properties = { title = "vm-app CPU", region = var.region, stat = "Average", period = 60, metrics = [["AWS/EC2", "CPUUtilization", "InstanceId", aws_instance.app.id]] } },
      { type = "metric", x = 12, y = 0, width = 12, height = 6, properties = { title = "vm-app memory", region = var.region, stat = "Average", period = 60, metrics = [["cloudlabs/${var.lab_id}", "mem_used_percent", "InstanceId", aws_instance.app.id]] } },
      { type = "metric", x = 0, y = 6, width = 12, height = 6, properties = { title = "App errors a minute", region = var.region, stat = "Sum", period = 60, metrics = [["cloudlabs/${var.lab_id}", "AppErrors"]] } },
      { type = "log", x = 12, y = 6, width = 12, height = 6, properties = { title = "Latest errors", region = var.region, query = "SOURCE '${aws_cloudwatch_log_group.app.name}' | fields @timestamp, @message | filter @message like /ERROR/ | sort @timestamp desc | limit 20" } },
    ]
  })
}

resource "aws_cloudwatch_query_definition" "errors" {
  name            = "lab-${var.lab_id}-errors"
  log_group_names = [aws_cloudwatch_log_group.app.name]
  query_string    = "fields @timestamp, @message\n| filter @message like /ERROR/\n| sort @timestamp desc\n| limit 50"
}

resource "aws_cloudwatch_event_rule" "state" {
  name        = "lab-${var.lab_id}-ec2-state"
  description = "vm-app starts, stops or terminates"
  event_pattern = jsonencode({
    source        = ["aws.ec2"]
    "detail-type" = ["EC2 Instance State-change Notification"]
    detail        = { "instance-id" = [aws_instance.app.id] }
  })
}

resource "aws_cloudwatch_event_target" "state_sns" {
  rule      = aws_cloudwatch_event_rule.state.name
  target_id = "sns"
  arn       = aws_sns_topic.alerts.arn
}
