# outputs.tf
#
# Plain English: what the dashboard shows once lab 13 is up: CloudShell lines
# to put an order on the bus, list the workflow's runs, and read the queues.

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "aws events put-events --region ${var.region} --entries '[{\"EventBusName\":\"${aws_cloudwatch_event_bus.orders.name}\",\"Source\":\"cloudlabs.shop\",\"DetailType\":\"OrderPlaced\",\"Detail\":\"{\\\"orderId\\\":\\\"o-1\\\",\\\"quantity\\\":2,\\\"price\\\":5}\"}]'",
    "aws stepfunctions list-executions --region ${var.region} --state-machine-arn ${aws_sfn_state_machine.orders.arn} --query 'executions[].[name,status]' --output table",
    "aws sqs receive-message --region ${var.region} --queue-url ${aws_sqs_queue.orders["billing"].id} --wait-time-seconds 5",
    "aws sqs receive-message --region ${var.region} --queue-url ${aws_sqs_queue.orders["shipping"].id} --wait-time-seconds 5",
    "aws sqs receive-message --region ${var.region} --queue-url ${aws_sqs_queue.billing_dlq.id} --wait-time-seconds 5",
  ]
}
