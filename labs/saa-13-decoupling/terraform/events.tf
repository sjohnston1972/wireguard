# events.tf
#
# Plain English: lab 13's events. A bus of the lab's own, lab-<id>-bus, and a
# rule on it, lab-<id>-placed, matching OrderPlaced events from
# cloudlabs.shop; its one target starts the workflow, as lab-<id>-events,
# allowed only to start that workflow (ruling P14).

resource "aws_cloudwatch_event_bus" "orders" {
  name = "lab-${var.lab_id}-bus"
  tags = { Name = "bus-orders" }
}

resource "aws_cloudwatch_event_rule" "placed" {
  name           = "lab-${var.lab_id}-placed"
  event_bus_name = aws_cloudwatch_event_bus.orders.name
  event_pattern  = jsonencode({ source = ["cloudlabs.shop"], "detail-type" = ["OrderPlaced"] })
  tags           = { Name = "rule-placed" }
}

resource "aws_iam_role" "events" {
  name                 = "lab-${var.lab_id}-events"
  path                 = "/cloudlabs-lab/"
  permissions_boundary = local.boundary_arn
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "events.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_policy" "events" {
  name = "lab-${var.lab_id}-events"
  path = "/cloudlabs-lab/"
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Sid = "StartTheWorkflow", Effect = "Allow", Action = "states:StartExecution", Resource = local.workflow_arn }]
  })
}

resource "aws_iam_role_policy_attachment" "events" {
  role       = aws_iam_role.events.name
  policy_arn = aws_iam_policy.events.arn
}

resource "aws_cloudwatch_event_target" "workflow" {
  rule           = aws_cloudwatch_event_rule.placed.name
  event_bus_name = aws_cloudwatch_event_bus.orders.name
  target_id      = "workflow"
  arn            = aws_sfn_state_machine.orders.arn
  role_arn       = aws_iam_role.events.arn
  depends_on     = [aws_iam_role_policy_attachment.events]
}
