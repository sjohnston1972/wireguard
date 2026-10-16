# flowlogs.tf
#
# Plain English: VPC Flow Logs for both of lab 08's VPCs, every accepted and
# rejected flow, in one-minute records, to /cloudlabs/<id>/flow (one day;
# ruling A56), written by the VPC Flow Logs service as the lab's role
# lab-<id>-flowlogs (under the lab boundary), allowed only that log group.

resource "aws_cloudwatch_log_group" "flow" {
  name              = "/cloudlabs/${var.lab_id}/flow"
  retention_in_days = 1
}

resource "aws_iam_role" "flowlogs" {
  name                 = "lab-${var.lab_id}-flowlogs"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
    }]
  })
}

resource "aws_iam_policy" "flowlogs" {
  name = "lab-${var.lab_id}-flowlogs"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "LabFlowLogGroup", Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"], Resource = "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/cloudlabs/${var.lab_id}/flow:*" },
      { Sid = "FindGroups", Effect = "Allow", Action = "logs:DescribeLogGroups", Resource = "*" },
    ]
  })
}

resource "aws_iam_role_policy_attachment" "flowlogs" {
  role       = aws_iam_role.flowlogs.name
  policy_arn = aws_iam_policy.flowlogs.arn
}

resource "aws_flow_log" "app" {
  vpc_id                   = aws_vpc.lab.id
  traffic_type             = "ALL"
  log_destination_type     = "cloud-watch-logs"
  log_destination          = aws_cloudwatch_log_group.flow.arn
  iam_role_arn             = aws_iam_role.flowlogs.arn
  max_aggregation_interval = 60
  tags                     = { Name = "flow-app" }
  depends_on               = [aws_iam_role_policy_attachment.flowlogs]
}

resource "aws_flow_log" "data" {
  vpc_id                   = aws_vpc.data.id
  traffic_type             = "ALL"
  log_destination_type     = "cloud-watch-logs"
  log_destination          = aws_cloudwatch_log_group.flow.arn
  iam_role_arn             = aws_iam_role.flowlogs.arn
  max_aggregation_interval = 60
  tags                     = { Name = "flow-data" }
  depends_on               = [aws_iam_role_policy_attachment.flowlogs]
}
