// scripts/test/fixtures/labs/plans/labs/soa-06-cloudformation.mjs
//
// Plain English: lab soa-06's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the
// template's resource group, then stack.tf (the CloudFormation service role,
// its policy and attachment, a short wait and the stack). The lab has no
// network.tf (ruling P3), so no zones and no AMI are read. The stack's
// template_body is cfn/stack.yaml as jsonencode prints it (object keys in
// lexical order), read here from the file so the two cannot drift; the role
// and the account-bearing ARNs in the policy are literal JSON (ruling P12).

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { ACCOUNT, AWS_PROVIDER_CONFIG, BOUNDARY, ctxAws, ref, tagged, templateMainData, templateMainResources } from "../common-aws.mjs";

const TEMPLATE = (() => {
  const doc = parseYaml(readFileSync(new URL("../../../../../../labs/soa-06-cloudformation/terraform/cfn/stack.yaml", import.meta.url), "utf8"));
  // jsonencode writes object keys in lexical order.
  const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
  return JSON.stringify(sorted(doc));
})();

export default () => {
  const c = ctxAws("soa-06-cloudformation", "06");
  const id = c.id;
  const region = c.variables.region;
  const stack = `lab-${id}-stack`;
  return {
    lab: id,
    variables: c.variables,
    providers: ["aws"],
    providerConfig: AWS_PROVIDER_CONFIG,
    data: templateMainData(),
    resources: [
      ...templateMainResources(c),
      {
        address: "aws_iam_role.cfn",
        values: tagged(c, {
          name: `lab-${id}-cfn`, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY,
          assume_role_policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "cloudformation.amazonaws.com" }, Action: "sts:AssumeRole" }] }),
        }),
        refs: { name: ["var.lab_id"], permissions_boundary: ["local.boundary_arn"] },
      },
      {
        address: "aws_iam_policy.cfn",
        values: tagged(c, {
          name: `lab-${id}-cfn`, path: "/cloudlabs-lab/",
          policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "StackItems", Effect: "Allow", Action: ["sns:*", "sqs:*", "cloudwatch:*"],
                Resource: [`arn:aws:sns:${region}:${ACCOUNT}:${stack}-*`, `arn:aws:sqs:${region}:${ACCOUNT}:${stack}-*`, `arn:aws:cloudwatch:${region}:${ACCOUNT}:alarm:${stack}-*`],
              },
              { Sid: "StackLogs", Effect: "Allow", Action: "logs:*", Resource: `arn:aws:logs:${region}:${ACCOUNT}:log-group:/cloudlabs/${id}/*` },
              { Sid: "StackParameters", Effect: "Allow", Action: "ssm:*", Resource: `arn:aws:ssm:${region}:${ACCOUNT}:parameter/cloudlabs/${id}/*` },
              { Sid: "Reads", Effect: "Allow", Action: ["sns:ListTopics", "sqs:ListQueues", "cloudwatch:DescribeAlarms", "logs:DescribeLogGroups", "ssm:DescribeParameters"], Resource: "*" },
            ],
          }),
        }),
        // Locals by their own names, once per use, in expression order.
        refs: {
          name: ["var.lab_id"],
          policy: [
            "var.region", "local.account", "local.stack_name",
            "var.region", "local.account", "local.stack_name",
            "var.region", "local.account", "local.stack_name",
            "var.region", "local.account", "var.lab_id",
            "var.region", "local.account", "var.lab_id",
          ],
        },
      },
      {
        address: "aws_iam_role_policy_attachment.cfn",
        values: { role: `lab-${id}-cfn` },
        unknown: ["policy_arn"],
        refs: { role: ref("aws_iam_role.cfn", "name"), policy_arn: ref("aws_iam_policy.cfn", "arn") },
      },
      { address: "time_sleep.cfn_role", values: { create_duration: "20s" }, refs: {} },
      {
        address: "aws_cloudformation_stack.lab",
        values: tagged(c, {
          name: stack, template_body: TEMPLATE, on_failure: "DELETE",
          parameters: { LabId: id, VisibilityTimeout: "30", MaxReceiveCount: "3", LogGroupName: `/cloudlabs/${id}/stack`, ParameterName: `/cloudlabs/${id}/config/greeting` },
          policy_body: JSON.stringify({ Statement: [{ Action: "Update:*", Effect: "Allow", Principal: "*", Resource: "*" }, { Action: ["Update:Replace", "Update:Delete"], Effect: "Deny", Principal: "*", Resource: "LogicalResourceId/WorkQueue" }] }),
          tags: { Name: "stack-lab" },
        }),
        unknown: ["iam_role_arn"],
        refs: { name: ["local.stack_name"], template_body: ["path.module"], iam_role_arn: ref("aws_iam_role.cfn", "arn"), parameters: ["var.lab_id", "var.lab_id", "var.lab_id"] },
      },
    ],
  };
};
