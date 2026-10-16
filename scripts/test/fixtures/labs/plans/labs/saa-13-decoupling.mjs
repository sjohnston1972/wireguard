// scripts/test/fixtures/labs/plans/labs/saa-13-decoupling.mjs
//
// Plain English: lab saa-13's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the
// template's resource group, then messaging.tf (the topic, the dead-letter
// queue, the two queues made by for_each, the wait, their two policies and
// the two subscriptions), workflow.tf (the log group, the function's role,
// the function, the workflow's role, policy and attachment, the state
// machine) and events.tf (the bus, the rule, the events role and the rule's
// target). The lab has no network.tf (ruling A61), so no zones and no AMI
// are read; data.archive_file.validate is read at plan with the zip's hash
// known. Every name, the queue policies (built from the account, region and
// topic name) and the state machine's definition (it names the function and
// topic by built ARNs) are known at plan; the billing queue's redrive policy
// is unknown (it holds the dead-letter queue's ARN). What is built from
// another resource's attribute is unknown, with its references: the
// subscriptions' topic_arn and endpoint, the policies' queue_url, the
// workflow's role_arn, the target's arn and role_arn.

import { ACCOUNT, AWS_PROVIDER_CONFIG, BOUNDARY, ctxAws, ref, tagged, templateMainData, templateMainResources } from "../common-aws.mjs";

export default () => {
  const c = ctxAws("saa-13-decoupling", "13");
  const id = c.id;
  const region = c.variables.region;
  const policyDoc = (statements) => JSON.stringify({ Version: "2012-10-17", Statement: statements });
  const archive = "data.archive_file.validate";
  const topicArn = `arn:aws:sns:${region}:${ACCOUNT}:lab-${id}-orders`;
  const validateArn = `arn:aws:lambda:${region}:${ACCOUNT}:function:lab-${id}-validate`;
  const workflowArn = `arn:aws:states:${region}:${ACCOUNT}:stateMachine:lab-${id}-orders`;
  const part = ref("data.aws_partition.current", "partition");
  const acct = ref("data.aws_caller_identity.current", "account_id");
  const queues = { forEach: { references: ["local.queues"] } };
  const queue = (key) => ({
    address: `aws_sqs_queue.orders["${key}"]`,
    ...queues,
    values: tagged(c, {
      name: `lab-${id}-${key}`, visibility_timeout_seconds: 20, message_retention_seconds: 86400, sqs_managed_sse_enabled: true,
      tags: { Name: `queue-${key}` },
    }),
    ...(key === "billing" ? { unknown: ["redrive_policy"] } : {}),
    refs: { name: ["var.lab_id", "each.key"], redrive_policy: ["each.key", ...ref("aws_sqs_queue.billing_dlq", "arn")], tags: ["each.key"] },
  });
  const queuePolicy = (key) => ({
    address: `aws_sqs_queue_policy.orders["${key}"]`,
    ...queues,
    values: {
      policy: policyDoc([{
        Sid: "FromTheLabTopic", Effect: "Allow", Principal: { Service: "sns.amazonaws.com" }, Action: "sqs:SendMessage",
        Resource: `arn:aws:sqs:${region}:${ACCOUNT}:lab-${id}-${key}`, Condition: { ArnEquals: { "aws:SourceArn": topicArn } },
      }]),
    },
    unknown: ["queue_url"],
    refs: { queue_url: ["aws_sqs_queue.orders", "each.key"], policy: [...part, "var.region", "local.account", "var.lab_id", "each.key", "local.topic_arn"] },
  });
  const subscription = (key) => ({
    address: `aws_sns_topic_subscription.orders["${key}"]`,
    ...queues,
    values: { protocol: "sqs", raw_message_delivery: true },
    unknown: ["topic_arn", "endpoint"],
    refs: { topic_arn: ref("aws_sns_topic.orders", "arn"), endpoint: ["aws_sqs_queue.orders", "each.key"] },
  });
  return {
    lab: id,
    variables: c.variables,
    providers: ["aws"],
    providerConfig: AWS_PROVIDER_CONFIG,
    data: [
      ...templateMainData(),
      {
        address: archive,
        values: { type: "zip", source_file: "/work/labs/saa-13-decoupling/terraform/lambda/validate.py", output_path: "/work/labs/saa-13-decoupling/terraform/.terraform/validate.zip", output_base64sha256: "Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmE=" },
        args: ["type"],
        refs: { source_file: ["path.module"], output_path: ["path.module"] },
      },
    ],
    resources: [
      ...templateMainResources(c),
      // messaging.tf
      { address: "aws_sns_topic.orders", values: tagged(c, { name: `lab-${id}-orders`, tags: { Name: "topic-orders" } }), refs: { name: ["var.lab_id"] } },
      {
        address: "aws_sqs_queue.billing_dlq",
        values: tagged(c, { name: `lab-${id}-billing-dlq`, message_retention_seconds: 86400, sqs_managed_sse_enabled: true, tags: { Name: "queue-billing-dlq" } }),
        refs: { name: ["var.lab_id"] },
      },
      queue("billing"),
      queue("shipping"),
      { address: "time_sleep.messaging_tags", values: { create_duration: "20s" }, refs: {} },
      queuePolicy("billing"),
      queuePolicy("shipping"),
      subscription("billing"),
      subscription("shipping"),
      // workflow.tf
      {
        address: "aws_cloudwatch_log_group.validate",
        values: tagged(c, { name: `/cloudlabs/${id}/validate`, retention_in_days: 1 }),
        refs: { name: ["var.lab_id"] },
      },
      {
        address: "aws_iam_role.validate",
        values: tagged(c, {
          name: `lab-${id}-validate`, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY,
          assume_role_policy: policyDoc([{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }]),
        }),
        refs: { name: ["var.lab_id"], permissions_boundary: ["local.boundary_arn"] },
      },
      {
        address: "aws_iam_role_policy_attachment.validate_logs",
        values: { role: `lab-${id}-validate`, policy_arn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" },
        refs: { role: ref("aws_iam_role.validate", "name") },
      },
      {
        address: "aws_lambda_function.validate",
        values: tagged(c, {
          function_name: `lab-${id}-validate`, runtime: "python3.13", architectures: ["arm64"], handler: "validate.handler", memory_size: 128, timeout: 10,
          logging_config: [{ log_format: "Text", log_group: `/cloudlabs/${id}/validate` }],
          tags: { Name: "fn-validate" },
        }),
        unknown: ["role"],
        refs: {
          function_name: ["var.lab_id"],
          role: ref("aws_iam_role.validate", "arn"),
          filename: ref(archive, "output_path"),
          source_code_hash: ref(archive, "output_base64sha256"),
          "logging_config.0.log_group": ref("aws_cloudwatch_log_group.validate", "name"),
        },
      },
      {
        address: "aws_iam_role.sfn",
        values: tagged(c, {
          name: `lab-${id}-sfn`, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY,
          assume_role_policy: policyDoc([{ Effect: "Allow", Principal: { Service: "states.amazonaws.com" }, Action: "sts:AssumeRole" }]),
        }),
        refs: { name: ["var.lab_id"], permissions_boundary: ["local.boundary_arn"] },
      },
      {
        address: "aws_iam_policy.sfn",
        values: tagged(c, {
          name: `lab-${id}-sfn`, path: "/cloudlabs-lab/",
          policy: policyDoc([
            { Sid: "Validate", Effect: "Allow", Action: "lambda:InvokeFunction", Resource: [validateArn, `${validateArn}:*`] },
            { Sid: "Publish", Effect: "Allow", Action: "sns:Publish", Resource: topicArn },
          ]),
        }),
        refs: { name: ["var.lab_id"], policy: ["local.validate_arn", "local.validate_arn", "local.topic_arn"] },
      },
      {
        address: "aws_iam_role_policy_attachment.sfn",
        values: { role: `lab-${id}-sfn` },
        unknown: ["policy_arn"],
        refs: { role: ref("aws_iam_role.sfn", "name"), policy_arn: ref("aws_iam_policy.sfn", "arn") },
      },
      {
        address: "aws_sfn_state_machine.orders",
        values: tagged(c, {
          name: `lab-${id}-orders`, type: "STANDARD",
          definition: JSON.stringify({
            Comment: `lab ${id}: validate an order, then fan it out`,
            StartAt: "Validate",
            States: {
              Validate: {
                Type: "Task", Resource: "arn:aws:states:::lambda:invoke",
                Parameters: { FunctionName: validateArn, "Payload.$": "$" },
                OutputPath: "$.Payload",
                Retry: [{ ErrorEquals: ["Lambda.ServiceException", "Lambda.TooManyRequestsException"], MaxAttempts: 2, IntervalSeconds: 2, BackoffRate: 2 }],
                Catch: [{ ErrorEquals: ["States.ALL"], Next: "Rejected" }],
                Next: "Publish",
              },
              Publish: { Type: "Task", Resource: "arn:aws:states:::sns:publish", Parameters: { TopicArn: topicArn, "Message.$": "$" }, End: true },
              Rejected: { Type: "Fail", Error: "OrderRejected", Cause: "the order did not validate" },
            },
          }),
          tags: { Name: "sfn-orders" },
        }),
        unknown: ["role_arn"],
        refs: { name: ["var.lab_id"], role_arn: ref("aws_iam_role.sfn", "arn"), definition: ["var.lab_id", "local.validate_arn", "local.topic_arn"] },
      },
      // events.tf
      { address: "aws_cloudwatch_event_bus.orders", values: tagged(c, { name: `lab-${id}-bus`, tags: { Name: "bus-orders" } }), refs: { name: ["var.lab_id"] } },
      {
        address: "aws_cloudwatch_event_rule.placed",
        values: tagged(c, { name: `lab-${id}-placed`, event_bus_name: `lab-${id}-bus`, event_pattern: JSON.stringify({ "detail-type": ["OrderPlaced"], source: ["cloudlabs.shop"] }), tags: { Name: "rule-placed" } }),
        refs: { name: ["var.lab_id"], event_bus_name: ref("aws_cloudwatch_event_bus.orders", "name") },
      },
      {
        address: "aws_iam_role.events",
        values: tagged(c, {
          name: `lab-${id}-events`, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY,
          assume_role_policy: policyDoc([{ Effect: "Allow", Principal: { Service: "events.amazonaws.com" }, Action: "sts:AssumeRole" }]),
        }),
        refs: { name: ["var.lab_id"], permissions_boundary: ["local.boundary_arn"] },
      },
      {
        address: "aws_iam_policy.events",
        values: tagged(c, {
          name: `lab-${id}-events`, path: "/cloudlabs-lab/",
          policy: policyDoc([{ Sid: "StartTheWorkflow", Effect: "Allow", Action: "states:StartExecution", Resource: workflowArn }]),
        }),
        refs: { name: ["var.lab_id"], policy: ["local.workflow_arn"] },
      },
      {
        address: "aws_iam_role_policy_attachment.events",
        values: { role: `lab-${id}-events` },
        unknown: ["policy_arn"],
        refs: { role: ref("aws_iam_role.events", "name"), policy_arn: ref("aws_iam_policy.events", "arn") },
      },
      {
        address: "aws_cloudwatch_event_target.workflow",
        values: { rule: `lab-${id}-placed`, event_bus_name: `lab-${id}-bus`, target_id: "workflow" },
        unknown: ["arn", "role_arn"],
        refs: {
          rule: ref("aws_cloudwatch_event_rule.placed", "name"),
          event_bus_name: ref("aws_cloudwatch_event_bus.orders", "name"),
          arn: ref("aws_sfn_state_machine.orders", "arn"),
          role_arn: ref("aws_iam_role.events", "arn"),
        },
      },
    ],
  };
};
