# stack.tf
#
# Plain English: lab 06's CloudFormation stack, lab-<id>-stack. Its template
# is cfn/stack.yaml in this folder, written with CloudFormation's long-form
# functions (Ref:, Fn::GetAtt:) because Terraform reads it with yamldecode,
# which knows no YAML tags; CloudFormation receives it as JSON. The stack is
# built by the lab's own service role, lab-<id>-cfn (under the lab boundary),
# allowed only the queues, topic, alarm, log group and parameter this stack
# names, so the stack can do no more than its template says (ruling P4). A
# stack policy keeps any update from replacing or deleting the work queue.

locals {
  stack_name = "lab-${var.lab_id}-stack"
  account    = data.aws_caller_identity.current.account_id
}

resource "aws_iam_role" "cfn" {
  name                 = "lab-${var.lab_id}-cfn"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "cloudformation.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_policy" "cfn" {
  name = "lab-${var.lab_id}-cfn"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "StackItems"
        Effect = "Allow"
        Action = ["sns:*", "sqs:*", "cloudwatch:*"]
        Resource = [
          "arn:aws:sns:${var.region}:${local.account}:${local.stack_name}-*",
          "arn:aws:sqs:${var.region}:${local.account}:${local.stack_name}-*",
          "arn:aws:cloudwatch:${var.region}:${local.account}:alarm:${local.stack_name}-*",
        ]
      },
      { Sid = "StackLogs", Effect = "Allow", Action = "logs:*", Resource = "arn:aws:logs:${var.region}:${local.account}:log-group:/cloudlabs/${var.lab_id}/*" },
      { Sid = "StackParameters", Effect = "Allow", Action = "ssm:*", Resource = "arn:aws:ssm:${var.region}:${local.account}:parameter/cloudlabs/${var.lab_id}/*" },
      { Sid = "Reads", Effect = "Allow", Action = ["sns:ListTopics", "sqs:ListQueues", "cloudwatch:DescribeAlarms", "logs:DescribeLogGroups", "ssm:DescribeParameters"], Resource = "*" },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "cfn" {
  role       = aws_iam_role.cfn.name
  policy_arn = aws_iam_policy.cfn.arn
}

# A new role takes a moment to reach CloudFormation; a stack created at once can be refused it.
resource "time_sleep" "cfn_role" {
  create_duration = "20s"
  depends_on      = [aws_iam_role_policy_attachment.cfn]
}

resource "aws_cloudformation_stack" "lab" {
  name          = local.stack_name
  template_body = jsonencode(yamldecode(file("${path.module}/cfn/stack.yaml")))
  iam_role_arn  = aws_iam_role.cfn.arn
  on_failure    = "DELETE"
  parameters = {
    LabId             = var.lab_id
    VisibilityTimeout = "30"
    MaxReceiveCount   = "3"
    LogGroupName      = "/cloudlabs/${var.lab_id}/stack"
    ParameterName     = "/cloudlabs/${var.lab_id}/config/greeting"
  }
  # The stack policy: any update may go ahead, but never one that replaces or deletes the work queue.
  policy_body = jsonencode({
    Statement = [
      { Effect = "Allow", Action = "Update:*", Principal = "*", Resource = "*" },
      { Effect = "Deny", Action = ["Update:Replace", "Update:Delete"], Principal = "*", Resource = "LogicalResourceId/WorkQueue" },
    ]
  })
  tags       = { Name = "stack-lab" }
  depends_on = [time_sleep.cfn_role]
}
