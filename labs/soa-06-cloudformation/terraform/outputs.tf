# outputs.tf
#
# Plain English: what the dashboard shows once lab 06 is up (AWS labs spec
# §4, §10): no instances and no peering, so only Connect lines that read the
# stack, send it a message and ask it about drift.

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "aws cloudformation describe-stacks --stack-name ${aws_cloudformation_stack.lab.name} --query 'Stacks[0].Outputs'",
    "aws sqs send-message --queue-url ${aws_cloudformation_stack.lab.outputs["WorkQueueUrl"]} --message-body hello",
    "aws cloudformation detect-stack-drift --stack-name ${aws_cloudformation_stack.lab.name}",
  ]
}
