# messaging.tf
#
# Plain English: lab 13's fan-out. The topic lab-<id>-orders delivers every
# order to two queues, lab-<id>-billing and lab-<id>-shipping (raw messages,
# encrypted at rest with SQS's own key). Billing gives a message three tries:
# received three times without being deleted, it moves to
# lab-<id>-billing-dlq, where it waits a day. Each queue's policy lets only
# this lab's topic send to it (ruling P14). A 20-second wait lets the new
# topic's and queues' tags reach IAM before the policies and subscriptions,
# which IAM judges by them (ruling P11).

locals {
  account   = data.aws_caller_identity.current.account_id
  topic_arn = "arn:${data.aws_partition.current.partition}:sns:${var.region}:${local.account}:lab-${var.lab_id}-orders"
  queues    = toset(["billing", "shipping"])
}

resource "aws_sns_topic" "orders" {
  name = "lab-${var.lab_id}-orders"
  tags = { Name = "topic-orders" }
}

resource "aws_sqs_queue" "billing_dlq" {
  name                      = "lab-${var.lab_id}-billing-dlq"
  message_retention_seconds = 86400
  sqs_managed_sse_enabled   = true
  tags                      = { Name = "queue-billing-dlq" }
}

resource "aws_sqs_queue" "orders" {
  for_each                   = local.queues
  name                       = "lab-${var.lab_id}-${each.key}"
  visibility_timeout_seconds = 20
  message_retention_seconds  = 86400
  sqs_managed_sse_enabled    = true
  redrive_policy             = each.key == "billing" ? jsonencode({ deadLetterTargetArn = aws_sqs_queue.billing_dlq.arn, maxReceiveCount = 3 }) : null
  tags                       = { Name = "queue-${each.key}" }
}

resource "time_sleep" "messaging_tags" {
  create_duration = "20s"
  depends_on      = [aws_sns_topic.orders, aws_sqs_queue.orders]
}

resource "aws_sqs_queue_policy" "orders" {
  for_each  = local.queues
  queue_url = aws_sqs_queue.orders[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "FromTheLabTopic"
      Effect    = "Allow"
      Principal = { Service = "sns.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = "arn:${data.aws_partition.current.partition}:sqs:${var.region}:${local.account}:lab-${var.lab_id}-${each.key}"
      Condition = { ArnEquals = { "aws:SourceArn" = local.topic_arn } }
    }]
  })
  depends_on = [time_sleep.messaging_tags]
}

resource "aws_sns_topic_subscription" "orders" {
  for_each             = local.queues
  topic_arn            = aws_sns_topic.orders.arn
  protocol             = "sqs"
  endpoint             = aws_sqs_queue.orders[each.key].arn
  raw_message_delivery = true
  depends_on           = [aws_sqs_queue_policy.orders]
}
