// lab-scope-aws.test.mjs
//
// Plain English: the AWS plan scope check (AWS labs spec §7.3): the
// template's plan passes, and each rule refuses one evil plan naming itself
// (§11). Plans are built as terraform show -json prints them
// (fixtures/labs/plans/realistic.mjs) from the AWS fixture helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AWS_CONFIG_LABS, AWS_DNS_LABS, AWS_GLOBAL_LABS, AWS_IAM_USER_LABS, AWS_INSTANCE_TYPES, AWS_MEDIUM_LABS, LAB_ID_RE } from "../lib/labs.mjs";
import * as scope from "../../infra/ci/lab-scope-aws.mjs";
import { planResources } from "../../infra/ci/lab-scope.mjs";
import { realisticPlan } from "./fixtures/labs/plans/realistic.mjs";
import { ACCOUNT, al2023Instance, AMI, AWS_PROVIDER_CONFIG, awsData, BOUNDARY, ctxAws, ref, tagged, templateMainResources, templateResources } from "./fixtures/labs/plans/common-aws.mjs";

const ID = "soa-01-cloudwatch";
const c = ctxAws(ID, "01");
const plan = (extra = [], { providerConfig = AWS_PROVIDER_CONFIG, variables = c.variables, base = templateResources(c) } = {}) =>
  realisticPlan({ resources: [...base, ...extra], data: awsData(), providers: ["aws"], providerConfig, variables });
const rules = (p, id = ID) => scope.checkPlanAws(p, id).map((x) => `${x.rule}: ${x.address}`);

test("the template's plan passes, and with an instance", () => {
  assert.deepEqual(rules(plan()), []);
  assert.deepEqual(rules(plan([al2023Instance(c, { key: "app", name: "vm-app" })])), []);
});

test("the constants equal the contract's copies", () => {
  assert.equal(scope.LAB_ID_RE.source, LAB_ID_RE.source);
  for (const [a, b] of [[scope.AWS_CONFIG_LABS, AWS_CONFIG_LABS], [scope.AWS_DNS_LABS, AWS_DNS_LABS], [scope.AWS_GLOBAL_LABS, AWS_GLOBAL_LABS],[scope.AWS_IAM_USER_LABS, AWS_IAM_USER_LABS], [scope.AWS_INSTANCE_TYPES, AWS_INSTANCE_TYPES], [scope.AWS_MEDIUM_LABS, AWS_MEDIUM_LABS]]) assert.deepEqual([...a], [...b]);
});

const role = (over = {}) => ({
  address: "aws_iam_role.vm",
  values: tagged(c, { name: `lab-${ID}-vm`, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY, assume_role_policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }] }), ...over }),
  refs: {},
});
const trustAws = (principal) => JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: principal }, Action: "sts:AssumeRole" }] });
const policy = (doc) => ({ address: "aws_iam_policy.extra", values: tagged(c, { name: `lab-${ID}-extra`, path: "/cloudlabs-lab/", policy: JSON.stringify(doc) }), refs: {} });
const c7 = ctxAws("soa-07-iam-kms", "07");
const c9 = ctxAws("soa-09-route53-cloudfront", "09");
const planFor = (cx) => (extra = []) => realisticPlan({ resources: [...templateMainResources(cx), ...extra], data: awsData(), providers: ["aws"], providerConfig: AWS_PROVIDER_CONFIG, variables: cx.variables });
const plan7 = planFor(c7);
const plan9 = planFor(c9);
const user7 = (over = {}) => ({ address: "aws_iam_user.ann", values: tagged(c7, { name: "lab-soa-07-iam-kms-ann", path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY, force_destroy: true, ...over }), refs: {} });
const tpl = (Resources) => JSON.stringify({ AWSTemplateFormatVersion: "2010-09-09", Resources });
const cfnRole = () => ({ ...role({ name: `lab-${ID}-cfn`, assume_role_policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "cloudformation.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }), address: "aws_iam_role.cfn" });
const stack = (over = {}, { noRole = false, unknown = [] } = {}) => ({
  address: "aws_cloudformation_stack.lab",
  values: tagged(c, { name: `lab-${ID}-stack`, template_body: tpl({ Q: { Type: "AWS::SQS::Queue" } }), parameters: {}, ...over }),
  unknown: [...(noRole ? [] : ["iam_role_arn"]), ...unknown],
  refs: noRole ? {} : { iam_role_arn: ref("aws_iam_role.cfn", "arn") },
});
const stackPlan = (over, opts) => plan([cfnRole(), stack(over, opts)]);
/** The template's resources with the lab group's resource_query.query replaced (review C-1; a string is used as is). */
const groupBase = (query) => {
  const base = templateResources(c);
  base[0] = { ...base[0], values: { ...base[0].values, resource_query: [{ type: "TAG_FILTERS_1_0", query: typeof query === "string" ? query : JSON.stringify(query) }] } };
  return base;
};
/** A template with a topic and one alarm whose properties are `props` (re-review N-1). */
const alarmTpl = (props, extra = {}) => tpl({ T: { Type: "AWS::SNS::Topic" }, A: { Type: "AWS::CloudWatch::Alarm", Properties: { MetricName: "CPUUtilization", Namespace: "AWS/EC2", Statistic: "Average", Period: 60, EvaluationPeriods: 1, Threshold: 1, ComparisonOperator: "GreaterThanThreshold", ...props } }, ...extra });
const withParams = (Parameters, Resources) => JSON.stringify({ AWSTemplateFormatVersion: "2010-09-09", Parameters, Resources });
/** Lab 06's template as the plan writes it (Task 7's cfn/stack.yaml, as yamldecode reads it): it must keep passing. */
const LAB06_TEMPLATE = {
  AWSTemplateFormatVersion: "2010-09-09",
  Description: "cloudlabs lab soa-06, a work queue with a dead-letter queue, an alarm and a topic",
  Parameters: {
    LabId: { Type: "String", Description: "The lab's id (Terraform passes var.lab_id)" },
    VisibilityTimeout: { Type: "Number", Default: 30, MinValue: 0, MaxValue: 900, Description: "Seconds a received message stays hidden from other consumers" },
    MaxReceiveCount: { Type: "Number", Default: 3, MinValue: 1, MaxValue: 10, Description: "Receives before a message moves to the dead-letter queue" },
    LogGroupName: { Type: "String", AllowedPattern: "^/cloudlabs/.+" },
    ParameterName: { Type: "String", AllowedPattern: "^/cloudlabs/.+" },
  },
  Resources: {
    DeadLetterQueue: { Type: "AWS::SQS::Queue", Properties: { MessageRetentionPeriod: 3600 } },
    WorkQueue: { Type: "AWS::SQS::Queue", Properties: { VisibilityTimeout: { Ref: "VisibilityTimeout" }, RedrivePolicy: { deadLetterTargetArn: { "Fn::GetAtt": ["DeadLetterQueue", "Arn"] }, maxReceiveCount: { Ref: "MaxReceiveCount" } } } },
    AlertTopic: { Type: "AWS::SNS::Topic", Properties: { DisplayName: "lab soa-06 alerts" } },
    OldestMessageAlarm: {
      Type: "AWS::CloudWatch::Alarm",
      Properties: { AlarmDescription: "A message has waited more than five minutes in the work queue", Namespace: "AWS/SQS", MetricName: "ApproximateAgeOfOldestMessage", Dimensions: [{ Name: "QueueName", Value: { "Fn::GetAtt": ["WorkQueue", "QueueName"] } }], Statistic: "Maximum", Period: 60, EvaluationPeriods: 5, Threshold: 300, ComparisonOperator: "GreaterThanThreshold", TreatMissingData: "notBreaching", AlarmActions: [{ Ref: "AlertTopic" }] },
    },
    StackLog: { Type: "AWS::Logs::LogGroup", Properties: { LogGroupName: { Ref: "LogGroupName" }, RetentionInDays: 1 } },
    Greeting: { Type: "AWS::SSM::Parameter", Properties: { Name: { Ref: "ParameterName" }, Type: "String", Value: "hello from CloudFormation", Description: "Change me by hand, then detect drift" } },
  },
  Outputs: { WorkQueueUrl: { Value: { Ref: "WorkQueue" } }, DeadLetterQueueUrl: { Value: { Ref: "DeadLetterQueue" } }, AlertTopicArn: { Value: { Ref: "AlertTopic" } } },
};
const LAB06_PARAMETERS = { LabId: ID, VisibilityTimeout: "30", MaxReceiveCount: "3", LogGroupName: `/cloudlabs/${ID}/stack`, ParameterName: `/cloudlabs/${ID}/greeting` };
const ALARM = { address: "aws_cloudwatch_metric_alarm.a", values: tagged(c, { alarm_name: `lab-${ID}-a`, comparison_operator: "GreaterThanThreshold", evaluation_periods: 1, metric_name: "CPUUtilization", namespace: "AWS/EC2", period: 300, statistic: "Average", threshold: 80 }) };
const fnLogs = { address: "aws_cloudwatch_log_group.f", values: tagged(c, { name: `/cloudlabs/${ID}/f`, retention_in_days: 1, skip_destroy: false }), refs: {} };
const lambdaFn = (over = {}) => ({ address: "aws_lambda_function.f", values: tagged(c, { function_name: `lab-${ID}-f`, runtime: "python3.13", handler: "f.handler", memory_size: 128, timeout: 30, logging_config: [{ log_format: "Text", log_group: `/cloudlabs/${ID}/f` }], ...over }), unknown: ["role"], refs: { role: ref("aws_iam_role.vm", "arn") } });
const ecsService = (over = {}) => ({ address: "aws_ecs_service.s", values: tagged(c, { name: `lab-${ID}-s`, desired_count: 2, launch_type: "FARGATE", propagate_tags: "SERVICE", ...over }), unknown: ["cluster", "task_definition"], refs: {} });

// [rule, what, a change to the clean plan]
const EVIL = [
  ["provider", "an aws provider with a profile", () => plan([], { providerConfig: { aws: { ...AWS_PROVIDER_CONFIG.aws, expressions: { ...AWS_PROVIDER_CONFIG.aws.expressions, profile: { constant_value: "admin" } } } } })],
  ["provider", "an aws provider in us-east-1 outside the global labs", () => plan([], { providerConfig: { aws: { ...AWS_PROVIDER_CONFIG.aws, expressions: { ...AWS_PROVIDER_CONFIG.aws.expressions, region: { constant_value: "us-east-1" } } } } })],
  ["provider", "a null provider resource", () => plan([{ address: "null_resource.x", values: {}, refs: {} }])],
  ["provider", "a resource in another region (aws provider 6's own region)", () => plan([{ address: "aws_sns_topic.far", values: tagged(c, { name: "far", region: "us-east-1" }), refs: {} }])],
  ["provisioner", "a provisioner", () => { const p = plan(); p.configuration.root_module.resources.find((r) => r.address === "aws_vpc.lab").provisioners = [{ type: "local-exec" }]; return p; }],
  ["import", "adopting an existing VPC", () => plan([{ ...templateResources(c)[1], address: "aws_vpc.adopted", importing: { id: "vpc-0123456789abcdef0" } }])],
  ["type", "a type not on the allow-list", () => plan([{ address: "aws_lightsail_instance.x", values: tagged(c, { name: "x" }), refs: {} }])],
  ["type", "a data source that looks up a VPC", () => realisticPlan({ resources: templateResources(c), data: [...awsData(), { address: "data.aws_vpc.wg", values: { tags: { Name: "vpc-x" } }, refs: {} }], providers: ["aws"], providerConfig: AWS_PROVIDER_CONFIG, variables: c.variables })],
  ["type", "a Config recorder outside lab 02", () => plan([{ address: "aws_config_configuration_recorder.r", values: { name: `lab-${ID}-recorder` }, unknown: ["role_arn"], refs: {} }])],
  // Ruling A48: what AWS made untagged with a VPC, or tags on an item that is already there: wg-admin-labs may not.
  ["type", "a VPC's default security group (aws_default_security_group)", () => plan([{ address: "aws_default_security_group.d", values: tagged(c, {}), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } }])],
  ["type", "a VPC's default network ACL (aws_default_network_acl)", () => plan([{ address: "aws_default_network_acl.d", values: tagged(c, {}), unknown: ["default_network_acl_id"], refs: {} }])],
  ["type", "a VPC's main route table (aws_default_route_table)", () => plan([{ address: "aws_default_route_table.d", values: tagged(c, {}), unknown: ["default_route_table_id"], refs: {} }])],
  ["type", "a tag on an existing item (aws_ec2_tag)", () => plan([{ address: "aws_ec2_tag.t", values: { resource_id: "acl-0123456789abcdef0", key: "cloudlabs-lab", value: ID }, refs: {} }])],
  ["never", "a Direct Connect gateway", () => plan([{ address: "aws_dx_gateway.x", values: { name: "x", amazon_side_asn: "64512" }, refs: {} }])],
  ["never", "an access key", () => plan([{ address: "aws_iam_access_key.x", values: { user: "x" }, refs: {} }])],
  ["tag", "a resource without the lab tag", () => plan([{ address: "aws_sns_topic.x", values: { name: "x", tags_all: { project: "cloudlabs" } }, refs: {} }])],
  ["tag", "an instance whose volumes miss the tag", () => { const i = al2023Instance(c, { key: "app", name: "vm-app" }); i.values.volume_tags = { Name: "vm-app" }; return plan([i]); }],
  ["untaggable", "a dashboard not named lab-<id>-*", () => plan([{ address: "aws_cloudwatch_dashboard.d", values: { dashboard_name: "overview", dashboard_body: "{}" }, refs: {} }])],
  ["iam", "a role outside /cloudlabs-lab/", () => plan([role({ path: "/" })])],
  ["iam", "a role without the boundary", () => plan([role({ permissions_boundary: null })])],
  ["iam", "a role trusting an account", () => plan([role({ assume_role_policy: JSON.stringify({ Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::999999999999:root" }, Action: "sts:AssumeRole" }] }) })])],
  // Final review, Important 4: a lab role's name in another account is not the lab's own role.
  ["iam", "a role trusting a lab-named role in another account", () => plan([role({ assume_role_policy: trustAws(`arn:aws:iam::999999999999:role/cloudlabs-lab/lab-${ID}-vm`) })])],
  ["iam", "a role trusting a lab-named role in any account (wildcard account)", () => plan([role({ assume_role_policy: trustAws(`arn:aws:iam::*:role/cloudlabs-lab/lab-${ID}-vm`) })])],
  ["iam", "a role trusting every lab role (wildcard name)", () => plan([role({ assume_role_policy: trustAws(`arn:aws:iam::${ACCOUNT}:role/cloudlabs-lab/lab-${ID}-*`) })])],
  ["iam", "a role trusting AWS = *", () => plan([role({ assume_role_policy: trustAws("*") })])],
  ["iam", "a role trusting Principal *", () => plan([role({ assume_role_policy: JSON.stringify({ Statement: [{ Effect: "Allow", Principal: "*", Action: "sts:AssumeRole" }] }) })])],
  ["iam", "a role trusting its own lab's role while its boundary names another account", () => plan([role({ permissions_boundary: "arn:aws:iam::999999999999:policy/wg-admin-lab-boundary", assume_role_policy: trustAws(`arn:aws:iam::999999999999:role/cloudlabs-lab/lab-${ID}-vm`) })])],
  ["iam", "a policy with an iam: action", () => plan([policy({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["iam:PassRole"], Resource: "*" }] })])],
  ["iam", "a policy with Action *", () => plan([policy({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }] })])],
  ["iam", "AdministratorAccess attached", () => plan([role(), { address: "aws_iam_role_policy_attachment.admin", values: { policy_arn: "arn:aws:iam::aws:policy/AdministratorAccess" }, unknown: ["role"], refs: { role: ref("aws_iam_role.vm", "name") } }])],
  ["iam", "AdministratorAccess in a role's managed_policy_arns (review round 1)", () => plan([role({ managed_policy_arns: ["arn:aws:iam::aws:policy/AdministratorAccess"] })])],
  ["iam", "a role's managed_policy_arns built from something not known at plan", () => { const r = role(); return plan([{ ...r, unknown: ["managed_policy_arns"], refs: { managed_policy_arns: ["data.aws_iam_policy_document.x.json", "data.aws_iam_policy_document.x"] } }]); }],
  ["iam", "a user outside soa-07", () => plan([{ address: "aws_iam_user.u", values: tagged(c, { name: `lab-${ID}-u`, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY }), refs: {} }])],
  ["gateway", "a route table named rt-wg", () => plan([{ address: "aws_route_table.gw", values: tagged(c, { tags: { Name: "rt-wg" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } }])],
  ["gateway", "a subnet in an existing VPC by id", () => plan([{ address: "aws_subnet.other", values: tagged(c, { vpc_id: "vpc-0a1b2c3d4e5f60718", cidr_block: "10.64.65.0/24" }), refs: {} }])],
  // Ruling A82: the role may now move a subnet's ACL association, so the plan holds ACLs and associations to the lab's own.
  ["gateway", "a network ACL in an existing VPC by id", () => plan([{ address: "aws_network_acl.other", values: tagged(c, { vpc_id: "vpc-0a1b2c3d4e5f60718" }), refs: {} }])],
  ["gateway", "a network ACL association on an existing subnet by id", () => plan([{ address: "aws_network_acl_association.other", values: { subnet_id: "subnet-0a1b2c3d4e5f60718" }, unknown: ["network_acl_id"], refs: { network_acl_id: ref("aws_network_acl.mine", "id") } }])],
  ["gateway", "a network ACL association onto an existing ACL by id", () => plan([{ address: "aws_network_acl_association.other", values: { network_acl_id: "acl-0a1b2c3d4e5f60718" }, unknown: ["subnet_id"], refs: { subnet_id: ref("aws_subnet.lab", "id") } }])],
  ["gateway", "a peering accepter", () => plan([{ address: "aws_vpc_peering_connection_accepter.x", values: tagged(c, { auto_accept: true }), unknown: ["vpc_peering_connection_id"], refs: {} }])],
  ["gateway", "a tag key wg-admin", () => plan([{ address: "aws_sns_topic.x", values: { name: "x", tags: { "wg-admin": "vpn" }, tags_all: { ...c.tags, "wg-admin": "vpn" } }, refs: {} }])],
  ["gateway", "an alarm on an existing instance (dimensions InstanceId, review round 1)", () => plan([{ address: "aws_cloudwatch_metric_alarm.cpu", values: tagged(c, { alarm_name: "cpu", comparison_operator: "GreaterThanThreshold", evaluation_periods: 1, metric_name: "CPUUtilization", namespace: "AWS/EC2", period: 300, statistic: "Average", threshold: 80, dimensions: { InstanceId: "i-0123456789abcdef0" } }), refs: {} }])],
  ["gateway", "an SSM association targeting existing instances by id", () => plan([{ address: "aws_ssm_association.patch", values: tagged(c, { name: "AWS-RunPatchBaseline", targets: [{ key: "InstanceIds", values: ["i-0123456789abcdef0"] }] }), refs: {} }])],
  ["gateway", "an EventBridge target running a command on existing instances", () => plan([{ address: "aws_cloudwatch_event_target.run", values: { arn: "arn:aws:ssm:eu-west-2::document/AWS-RunShellScript", run_command_targets: [{ key: "InstanceIds", values: ["i-0123456789abcdef0"] }] }, unknown: ["rule", "role_arn"], refs: { role_arn: ref("aws_iam_role.vm", "arn") } }, role()])],
  // Final review, Important 3: the VPN server's other names, and instance targets that select every instance.
  ...["vm-wg", "nic-wg", "pip-wg", "osdisk-wg", "sg-workloads", "vm-test", "osdisk-test"].map((n) => ["gateway", `an SSM association targeting tag:Name = ${n}`, () => plan([{ address: "aws_ssm_association.x", values: tagged(c, { name: "AWS-RunShellScript", targets: [{ key: "tag:Name", values: [n] }] }), refs: {} }])]),
  ["gateway", "an SSM association targeting InstanceIds = *", () => plan([{ address: "aws_ssm_association.all", values: tagged(c, { name: "AWS-RunShellScript", targets: [{ key: "InstanceIds", values: ["*"] }] }), refs: {} }])],
  ["gateway", "an SSM association on instance_id = *", () => plan([{ address: "aws_ssm_association.all", values: tagged(c, { name: "AWS-RunShellScript", instance_id: "*" }), refs: {} }])],
  ["gateway", "an SSM association targeting every instance with a Name tag (tag-key)", () => plan([{ address: "aws_ssm_association.all", values: tagged(c, { name: "AWS-RunShellScript", targets: [{ key: "tag-key", values: ["Name"] }] }), refs: {} }])],
  ["gateway", "an SSM association targeting a wildcard tag value", () => plan([{ address: "aws_ssm_association.all", values: tagged(c, { name: "AWS-RunShellScript", targets: [{ key: "tag:Name", values: ["vm-*"] }] }), refs: {} }])],
  ["gateway", "an EventBridge target running a command on InstanceIds *", () => plan([{ address: "aws_cloudwatch_event_target.run", values: { arn: "arn:aws:ssm:eu-west-2::document/AWS-RunShellScript", run_command_targets: [{ key: "InstanceIds", values: ["*"] }] }, unknown: ["rule", "role_arn"], refs: { role_arn: ref("aws_iam_role.vm", "arn") } }, role()])],
  ["gateway", "an EventBridge target running a command on vm-wg by name", () => plan([{ address: "aws_cloudwatch_event_target.run", values: { arn: "arn:aws:ssm:eu-west-2::document/AWS-RunShellScript", run_command_targets: [{ key: "tag:Name", values: ["vm-wg"] }] }, unknown: ["rule", "role_arn"], refs: { role_arn: ref("aws_iam_role.vm", "arn") } }, role()])],
  ["gateway", "a backup selection naming an existing instance by ARN", () => plan([{ address: "aws_backup_selection.vms", values: { name: "vms", resources: ["arn:aws:ec2:eu-west-2:123456789012:instance/i-0123456789abcdef0"] }, unknown: ["plan_id", "iam_role_arn"], refs: {} }])],
  ["address", "a VPC outside the slot", () => { const base = templateResources(c); base[1] = { ...base[1], values: { ...base[1].values, cidr_block: "10.65.0.0/20" } }; return plan([], { base }); }],
  ["address", "a route to another lab's slot", () => plan([{ address: "aws_route.other", values: { destination_cidr_block: "10.66.0.0/18" }, unknown: ["route_table_id", "vpc_peering_connection_id"], refs: { route_table_id: ref("aws_route_table.private", "id"), vpc_peering_connection_id: ref("aws_vpc_peering_connection.other", "id") } }])],
  ["public", "an instance with a public IP", () => { const i = al2023Instance(c, { key: "app", name: "vm-app" }); i.values.associate_public_ip_address = true; return plan([i]); }],
  ["public", "a subnet that maps public IPs", () => { const base = templateResources(c); base[2] = { ...base[2], values: { ...base[2].values, map_public_ip_on_launch: true } }; return plan([], { base }); }],
  ["public", "SSH from the internet", () => plan([{ address: "aws_vpc_security_group_ingress_rule.ssh_world", values: tagged(c, { cidr_ipv4: "0.0.0.0/0", ip_protocol: "tcp", from_port: 22, to_port: 22 }), unknown: ["security_group_id"], refs: { security_group_id: ref("aws_security_group.vms", "id") } }])],
  ["lingering", "a database that keeps a final snapshot", () => plan([{ address: "aws_db_subnet_group.db", values: tagged(c, { name: `lab-${ID}-db` }), unknown: ["subnet_ids"], refs: { subnet_ids: ["aws_subnet.private"] } }, { address: "aws_db_instance.db", values: tagged(c, { instance_class: "db.t4g.micro", allocated_storage: 20, skip_final_snapshot: false, deletion_protection: false, delete_automated_backups: true, copy_tags_to_snapshot: true }), unknown: ["db_subnet_group_name"], refs: { db_subnet_group_name: ref("aws_db_subnet_group.db", "name") } }])],
  ["lingering", "a bucket that cannot be force-destroyed", () => plan([{ address: "aws_s3_bucket.b", values: tagged(c, { bucket: `cloudlabs-${c.prefix}-x`, force_destroy: false }), refs: {} }])],
  ["lingering", "a log group kept for 30 days", () => plan([{ address: "aws_cloudwatch_log_group.g", values: tagged(c, { name: `/cloudlabs/${ID}/x`, retention_in_days: 30, skip_destroy: false }), refs: {} }])],
  ["lingering", "a log group with deletion protection on", () => plan([{ address: "aws_cloudwatch_log_group.g", values: tagged(c, { name: `/cloudlabs/${ID}/x`, retention_in_days: 1, skip_destroy: false, deletion_protection_enabled: true }), refs: {} }])],
  ["untaggable", "a log group named outside /cloudlabs/<lab id>/ (ruling A56)", () => plan([{ address: "aws_cloudwatch_log_group.g", values: tagged(c, { name: "/aws/lambda/x", retention_in_days: 3, skip_destroy: false }), refs: {} }])],
  ["untaggable", "a log group named for another lab (ruling A56)", () => plan([{ address: "aws_cloudwatch_log_group.g", values: tagged(c, { name: "/cloudlabs/soa-02-systems-manager/x", retention_in_days: 3, skip_destroy: false }), refs: {} }])],
  ["lingering", "a load balancer with deletion protection", () => plan([{ address: "aws_lb.web", values: tagged(c, { name: "alb-x", internal: false, load_balancer_type: "application", enable_deletion_protection: true }), unknown: ["subnets", "security_groups"], refs: { subnets: ["aws_subnet.private"], security_groups: ref("aws_security_group.vms", "id") } }])],
  ["size", "an m5.large instance", () => plan([al2023Instance(c, { key: "big", name: "vm-big", type: "m5.large" })])],
  ["size", "a 100 GiB volume", () => plan([{ address: "aws_ebs_volume.big", values: tagged(c, { availability_zone: "eu-west-2a", size: 100, type: "gp3" }), refs: {} }])],
  ["size", "an Auto Scaling group of 10", () => plan([{ address: "aws_autoscaling_group.g", values: { min_size: 2, max_size: 10, desired_capacity: 2, tag: [{ key: "cloudlabs-lab", value: ID, propagate_at_launch: true }] }, unknown: ["vpc_zone_identifier"], refs: { vpc_zone_identifier: ["aws_subnet.private"] } }])],
  ["description", "a security group description with an apostrophe", () => plan([{ address: "aws_security_group.apos", values: tagged(c, { name: "lab-apos", description: "SSH out to the lab's instances" }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } }])],
  ["description", "a security group description of 256 characters", () => plan([{ address: "aws_security_group.long", values: tagged(c, { name: "lab-long", description: "a".repeat(256) }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } }])],
  ["description", "an ingress block description with a quote", () => plan([{ address: "aws_security_group.blk", values: tagged(c, { name: "lab-blk", description: "ok", ingress: [{ description: 'say "hi"', protocol: "tcp", from_port: 80, to_port: 80, cidr_blocks: ["10.0.0.0/8"] }] }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } }])],
  ["description", "a VPC security group rule description with a backtick", () => plan([{ address: "aws_vpc_security_group_egress_rule.r", values: tagged(c, { description: "all `out`", ip_protocol: "-1", cidr_ipv4: "10.0.0.0/8" }), unknown: ["security_group_id"], refs: { security_group_id: ref("aws_security_group.vms", "id") } }])],
  // Batch 2 (rulings P4, P6–P10, P14).
  ["type", "an Access Analyzer analyzer outside lab 07", () => plan([{ address: "aws_accessanalyzer_analyzer.a", values: tagged(c, { analyzer_name: `lab-${ID}-a`, type: "ACCOUNT" }), refs: {} }])],
  ["type", "an organization analyzer in lab 07", () => plan7([{ address: "aws_accessanalyzer_analyzer.a", values: tagged(c7, { analyzer_name: "lab-soa-07-iam-kms-a", type: "ORGANIZATION" }), refs: {} }]), "soa-07-iam-kms"],
  ["never", "a StackSet", () => plan([{ address: "aws_cloudformation_stack_set.s", values: tagged(c, { name: `lab-${ID}-set` }), refs: {} }])],
  ["template", "a stack from a template URL", () => stackPlan({ template_url: "https://example.com/t.json" })],
  ["template", "a stack without its own service role", () => stackPlan({}, { noRole: true })],
  ["template", "a stack with IAM capabilities", () => stackPlan({ capabilities: ["CAPABILITY_NAMED_IAM"] })],
  ["template", "a template with an IAM role", () => stackPlan({ template_body: tpl({ R: { Type: "AWS::IAM::Role", Properties: {} } }) })],
  ["template", "a template with a nested stack", () => stackPlan({ template_body: tpl({ N: { Type: "AWS::CloudFormation::Stack", Properties: { TemplateURL: "https://example.com/n.json" } } }) })],
  ["template", "a template with a custom resource", () => stackPlan({ template_body: tpl({ C: { Type: "Custom::Thing", Properties: { ServiceToken: "arn:aws:lambda:eu-west-2:123456789012:function:x" } } }) })],
  ["template", "a template with a Transform", () => stackPlan({ template_body: JSON.stringify({ Transform: "AWS::Serverless-2016-10-31", Resources: { Q: { Type: "AWS::SQS::Queue" } } }) })],
  ["template", "a template that keeps a queue after tear-down (Retain)", () => stackPlan({ template_body: tpl({ Q: { Type: "AWS::SQS::Queue", DeletionPolicy: "Retain" } }) })],
  ["template", "a template whose log group has deletion protection on", () => stackPlan({ template_body: tpl({ L: { Type: "AWS::Logs::LogGroup", Properties: { LogGroupName: `/cloudlabs/${ID}/x`, RetentionInDays: 1, DeletionProtectionEnabled: true } } }) })],
  ["template", "a template that names its queue", () => stackPlan({ template_body: tpl({ Q: { Type: "AWS::SQS::Queue", Properties: { QueueName: "orders" } } }) })],
  ["template", "a template with a log group outside /cloudlabs/<id>/", () => stackPlan({ template_body: tpl({ L: { Type: "AWS::Logs::LogGroup", Properties: { LogGroupName: "/aws/other", RetentionInDays: 1 } } }) })],
  ["template", "a template importing another stack's output", () => stackPlan({ template_body: tpl({ T: { Type: "AWS::SNS::Topic", Properties: { DisplayName: { "Fn::ImportValue": "other-export" } } } }) })],
  ["provider", "a bucket in us-east-1 in lab 09 (only WAF for CloudFront lives there)", () => plan9([{ address: "aws_s3_bucket.far", values: tagged(c9, { bucket: `cloudlabs-${c9.prefix}-far`, force_destroy: true, region: "us-east-1" }), refs: {} }]), "soa-09-route53-cloudfront"],
  ["provider", "a secret replicated to Ireland", () => plan([{ address: "aws_secretsmanager_secret.s", values: tagged(c, { name: `lab-${ID}-s`, recovery_window_in_days: 0, replica: [{ region: "eu-west-1" }] }), refs: {} }])],
  ["iam", "a login profile that forces a password reset", () => plan7([user7(), { address: "aws_iam_user_login_profile.ann", values: { user: "lab-soa-07-iam-kms-ann", password_reset_required: true }, refs: { user: ref("aws_iam_user.ann", "name") } }]), "soa-07-iam-kms"],
  ["iam", "a function running as a role the lab did not make", () => plan([fnLogs, { ...lambdaFn({ role: "arn:aws:iam::123456789012:role/wg-admin-labs" }), unknown: [], refs: {} }])],
  ["lingering", "a user that hand-made keys would keep (force_destroy false)", () => plan7([user7({ force_destroy: false })]), "soa-07-iam-kms"],
  ["gateway", "an SSM association on tag:managed = terraform (ruling P9)", () => plan([{ address: "aws_ssm_association.x", values: tagged(c, { name: "AWS-RunShellScript", targets: [{ key: "tag:managed", values: ["terraform"] }] }), refs: {} }])],
  ["gateway", "an SSM association on someone else's resource group", () => plan([{ address: "aws_ssm_association.rg", values: tagged(c, { name: "AWS-RunShellScript", targets: [{ key: "resource-groups:Name", values: ["everything"] }] }), refs: {} }])],
  ["gateway", "a public zone not named <name_prefix>.labs.clydeford.net", () => plan9([{ address: "aws_route53_zone.z", values: tagged(c9, { name: "example.com", force_destroy: true }), refs: {} }]), "soa-09-route53-cloudfront"],
  ["gateway", "a health check on a site the lab does not own", () => plan9([{ address: "aws_route53_health_check.h", values: tagged(c9, { fqdn: "www.example.com", type: "HTTP", port: 80, resource_path: "/", request_interval: 30, failure_threshold: 3 }), refs: {} }]), "soa-09-route53-cloudfront"],
  ["public", "a bucket policy allowing Principal *", () => plan([{ address: "aws_s3_bucket_policy.p", values: { policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: `arn:aws:s3:::cloudlabs-${c.prefix}-x/*` }] }) }, unknown: ["bucket"], refs: {} }])],
  ["public", "a topic policy allowing another account", () => plan([{ address: "aws_sns_topic_policy.p", values: { policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "arn:aws:iam::999999999999:root" }, Action: "sns:Publish", Resource: "*" }] }) }, unknown: ["arn"], refs: {} }])],
  // Preflight C12: a topic's own (inline) policy is read too.
  ["public", "a topic whose own policy allows Principal *", () => plan([{ address: "aws_sns_topic.open", values: tagged(c, { name: `lab-${ID}-open`, policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "sns:Publish", Resource: "*" }] }) }), refs: {} }])],
  ["public", "a Lambda permission for anyone (principal *)", () => plan([{ address: "aws_lambda_permission.p", values: { action: "lambda:InvokeFunction", principal: "*", statement_id: "all" }, unknown: ["function_name"], refs: {} }])],
  // Task 3 fix round 1, I-1: a queue's own policy.
  ["public", "a queue whose own policy allows Principal *", () => plan([{ address: "aws_sqs_queue.open", values: tagged(c, { name: `lab-${ID}-open`, policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "sqs:*", Resource: "*" }] }) }), refs: {} }])],
  ["public", "a queue whose own policy allows another account", () => plan([{ address: "aws_sqs_queue.open", values: tagged(c, { name: `lab-${ID}-open`, policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: "999999999999" }, Action: "sqs:SendMessage", Resource: "*" }] }) }), refs: {} }])],
  ["public", "an ECS service giving its tasks public IPs", () => plan([ecsService({ network_configuration: [{ assign_public_ip: true }] })])],
  ["size", "a distribution in every edge location (PriceClass_All)", () => plan9([{ address: "aws_cloudfront_distribution.d", values: tagged(c9, { enabled: true, price_class: "PriceClass_All", retain_on_delete: false }), refs: {} }]), "soa-09-route53-cloudfront"],
  ["size", "an ECS service of 10 tasks", () => plan([ecsService({ desired_count: 10 })])],
  ["size", "a Lambda function with 3 GB of memory", () => plan([role(), fnLogs, lambdaFn({ memory_size: 3008 })])],
  // Task 3 review, fix round 1: the bypasses the probe found (each passed before its fix).
  ["gateway", "a lab group selecting every instance with a Name tag, targeted by resource-groups:Name (review C-1)", () => plan([{ address: "aws_ssm_association.rg", values: tagged(c, { name: "AWS-RunShellScript", targets: [{ key: "resource-groups:Name", values: [`lab-${ID}`] }] }), refs: {} }], { base: groupBase({ ResourceTypeFilters: ["AWS::EC2::Instance"], TagFilters: [{ Key: "Name" }] }) })],
  ["template", "a template alarm on an existing instance by id (review I-1)", () => stackPlan({ template_body: tpl({ A: { Type: "AWS::CloudWatch::Alarm", Properties: { MetricName: "CPUUtilization", Namespace: "AWS/EC2", Dimensions: [{ Name: "InstanceId", Value: "i-0123456789abcdef0" }], Statistic: "Average", Period: 60, EvaluationPeriods: 1, Threshold: 1, ComparisonOperator: "GreaterThanThreshold" } } }) })],
  ["template", "a template alarm that terminates an instance (EC2 alarm action, review I-1)", () => stackPlan({ template_body: tpl({ A: { Type: "AWS::CloudWatch::Alarm", Properties: { MetricName: "CPUUtilization", Namespace: "AWS/EC2", Statistic: "Average", Period: 60, EvaluationPeriods: 1, Threshold: 1, ComparisonOperator: "GreaterThanThreshold", AlarmActions: ["arn:aws:automate:eu-west-2:ec2:terminate"] } } }) })],
  ["gateway", "a Terraform alarm with an EC2 action (review I-1)", () => plan([{ address: "aws_cloudwatch_metric_alarm.stop", values: tagged(c, { alarm_name: `lab-${ID}-stop`, comparison_operator: "GreaterThanThreshold", evaluation_periods: 1, metric_name: "CPUUtilization", namespace: "AWS/EC2", period: 300, statistic: "Average", threshold: 80, alarm_actions: ["arn:aws:swf:eu-west-2:123456789012:action/actions/AWS_EC2.InstanceId.Stop/1.0"] }), unknown: ["dimensions"], refs: { dimensions: ref("aws_instance.app", "id") } }])],
  ["public", "a KMS key policy not known until apply, with no references (review I-2)", () => plan([{ address: "aws_kms_key.k", values: tagged(c, { deletion_window_in_days: 7 }), unknown: ["policy"], refs: {} }])],
  ["public", "a Lambda permission whose principal is not known until apply (review I-2)", () => plan([{ address: "aws_lambda_permission.p", values: { action: "lambda:InvokeFunction", statement_id: "x" }, unknown: ["function_name", "principal"], refs: {} }])],
  ["public", "a Lambda permission whose function URL auth is not known until apply (review I-2)", () => plan([{ address: "aws_lambda_permission.p", values: { action: "lambda:InvokeFunctionUrl", principal: "events.amazonaws.com", statement_id: "x" }, unknown: ["function_name", "function_url_auth_type"], refs: {} }])],
  ["public", "a bucket whose own policy allows Principal * (review I-3)", () => plan([{ address: "aws_s3_bucket.open", values: tagged(c, { bucket: `cloudlabs-${c.prefix}-open`, force_destroy: true, policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "*" }] }) }), refs: {} }])],
  ["template", "a stack whose parameters are not known until apply (review I-4)", () => stackPlan({ template_body: JSON.stringify({ Parameters: { N: { Type: "String", Default: `/cloudlabs/${ID}/x` } }, Resources: { L: { Type: "AWS::Logs::LogGroup", Properties: { LogGroupName: { Ref: "N" }, RetentionInDays: 1 } } } }), parameters: undefined }, { unknown: ["parameters"] })],
  ["template", "a stack whose capabilities are not known until apply (review I-4)", () => stackPlan({}, { unknown: ["capabilities"] })],
  ["public", "a bucket policy allowing Principal * with Effect \"allow\" (review M-1)", () => plan([{ address: "aws_s3_bucket_policy.p", values: { policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "allow", Principal: "*", Action: "s3:GetObject", Resource: "*" }] }) }, unknown: ["bucket"], refs: {} }])],
  ["gateway", "a distribution in front of a look-alike domain cloudlabs-<prefix>-x.evil.example.com (review M-3)", () => plan9([{ address: "aws_cloudfront_distribution.d", values: tagged(c9, { enabled: true, price_class: "PriceClass_100", retain_on_delete: false, origin: [{ origin_id: "x", domain_name: `cloudlabs-${c9.prefix}-x.evil.example.com` }] }), refs: {} }]), "soa-09-route53-cloudfront"],
  ["provider", "a resource whose own region is not known until apply, with no references (review M-4)", () => plan([{ address: "aws_sns_topic.far", values: tagged(c, { name: `lab-${ID}-far` }), unknown: ["region"], refs: {} }])],
  // Fix round 2 (task-3-rereview.md): each passed before its fix.
  ["template", "an instance id built by Fn::Join (re-review N-1)", () => stackPlan({ template_body: alarmTpl({ Dimensions: [{ Name: "InstanceId", Value: { "Fn::Join": ["", ["i-0123", "456789abcdef0"]] } }], AlarmActions: [{ Ref: "T" }] }) })],
  ["template", "an instance id built by Fn::Sub (re-review N-1)", () => stackPlan({ template_body: alarmTpl({ Dimensions: [{ Name: "InstanceId", Value: { "Fn::Sub": ["i-${X}", { X: "0123456789abcdef0" }] } }], AlarmActions: [{ Ref: "T" }] }) })],
  ["template", "an instance id picked by Fn::Select and Fn::Split (re-review N-1)", () => stackPlan({ template_body: alarmTpl({ Dimensions: [{ Name: "InstanceId", Value: { "Fn::Select": [1, { "Fn::Split": [",", "x,i-0123456789abcdef0"] }] } }], AlarmActions: [{ Ref: "T" }] }) })],
  ["template", "an EC2 alarm action built by Fn::Sub (re-review N-1)", () => stackPlan({ template_body: alarmTpl({ AlarmActions: [{ "Fn::Sub": "arn:${AWS::Partition}:automate:${AWS::Region}:ec2:terminate" }] }) })],
  ["template", "an instance id passed in through the stack's parameters (re-review N-1)", () => stackPlan({ template_body: withParams({ X: { Type: "String" } }, { T: { Type: "AWS::SNS::Topic" }, A: JSON.parse(alarmTpl({ Dimensions: [{ Name: "InstanceId", Value: { Ref: "X" } }], AlarmActions: [{ Ref: "T" }] })).Resources.A }), parameters: { X: "i-0123456789abcdef0" } })],
  ["template", "an EC2 alarm action passed in through the stack's parameters (re-review N-1)", () => stackPlan({ template_body: withParams({ X: { Type: "String" } }, { A: JSON.parse(alarmTpl({ AlarmActions: [{ Ref: "X" }] })).Resources.A }), parameters: { X: "arn:aws:automate:eu-west-2:ec2:terminate" } })],
  ["template", "a stack parameter not known until apply (re-review N-1)", () => stackPlan({ template_body: withParams({ X: { Type: "String" } }, { T: { Type: "AWS::SNS::Topic" } }), parameters: { X: "x" } }, { unknown: ["parameters.X"] })],
  ["template", "a parameter typed AWS::SSM::Parameter::Value<String> (re-review N-1)", () => stackPlan({ template_body: withParams({ X: { Type: "AWS::SSM::Parameter::Value<String>", Default: "/some/where" } }, { T: { Type: "AWS::SNS::Topic", Properties: { DisplayName: { Ref: "X" } } } }) })],
  ["template", "a List parameter (re-review N-1)", () => stackPlan({ template_body: withParams({ X: { Type: "CommaDelimitedList", Default: "a,b" } }, { T: { Type: "AWS::SNS::Topic" } }) })],
  ["template", "a {{resolve:ssm:...}} dynamic reference (re-review N-1)", () => stackPlan({ template_body: alarmTpl({ Dimensions: [{ Name: "InstanceId", Value: "{{resolve:ssm:/some/instance}}" }], AlarmActions: [{ Ref: "T" }] }) })],
  ["template", "an alarm action that is not a topic of the template's own (re-review N-1)", () => stackPlan({ template_body: alarmTpl({ AlarmActions: [{ Ref: "Q" }] }, { Q: { Type: "AWS::SQS::Queue" } }) })],
  ["template", "an upper-case EC2 alarm action ARN:AWS:AUTOMATE: (re-review N-1)", () => stackPlan({ template_body: alarmTpl({ OKActions: ["ARN:AWS:AUTOMATE:eu-west-2:ec2:stop"] }) })],
  ["gateway", "a Terraform alarm action not known until apply, with no references (re-review N-2)", () => plan([{ ...ALARM, unknown: ["alarm_actions"], refs: {} }])],
  ["gateway", "a Terraform alarm action built from a lab function, not its topic (re-review N-2)", () => plan([{ ...ALARM, unknown: ["alarm_actions"], refs: { alarm_actions: ref("aws_lambda_function.f", "arn") } }])],
  ["gateway", "a Terraform alarm dimension InstanceId not known until apply, with no references (re-review N-2)", () => plan([{ ...ALARM, values: { ...ALARM.values, dimensions: {} }, unknown: ["dimensions.InstanceId"], refs: {} }])],
  ["gateway", "an SSM association's InstanceId parameter not known until apply, with no references (re-review N-2)", () => plan([{ address: "aws_ssm_association.stop", values: tagged(c, { name: "AWS-StopEC2Instance", parameters: {} }), unknown: ["parameters.InstanceId"], refs: {} }])],
  ["gateway", "an EventBridge target's input not known until apply, with no references (re-review N-2)", () => plan([{ address: "aws_cloudwatch_event_target.stop", values: { arn: "arn:aws:events:eu-west-2:123456789012:target/stop-instance" }, unknown: ["rule", "input"], refs: { rule: ref("aws_cloudwatch_event_rule.r", "name") } }])],
  ["gateway", "a group query with duplicate TagFilters keys (re-review N-3)", () => plan([], { base: groupBase(`{"ResourceTypeFilters":["AWS::AllSupported"],"TagFilters":[{"Key":"Name"}],"TagFilters":[{"Key":"cloudlabs-lab","Values":["${ID}"]}]}`) })],
  ["gateway", "a group query with duplicate Key keys (re-review N-3)", () => plan([], { base: groupBase(`{"ResourceTypeFilters":["AWS::AllSupported"],"TagFilters":[{"Key":"Name","Key":"cloudlabs-lab","Values":["${ID}"]}]}`) })],
  ["template", "a template_body with duplicate Type keys (review M-2)", () => stackPlan({ template_body: `{"Resources":{"R":{"Type":"AWS::IAM::Role","Type":"AWS::SQS::Queue"}}}` })],
  ["public", "a bucket policy with duplicate Principal keys (re-review N-3)", () => plan([{ address: "aws_s3_bucket_policy.p", values: { policy: `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":"*","Principal":{"Service":"cloudfront.amazonaws.com"},"Action":"s3:GetObject","Resource":"*"}]}` }, unknown: ["bucket"], refs: {} }])],
];
for (const [rule, what, make, id = ID] of EVIL) {
  test(`${rule}: refuses ${what}`, () => {
    const got = scope.checkPlanAws(make(), id);
    assert.ok(got.some((p) => p.rule === rule), `${rule} expected, got ${JSON.stringify(got.map((p) => `${p.rule}: ${p.address} (${p.message})`))}`);
  });
}

test("a VPC's untagged defaults and aws_ec2_tag are refused in words, not left to an AccessDenied at apply (ruling A48)", () => {
  for (const t of ["aws_default_security_group", "aws_default_network_acl", "aws_default_route_table", "aws_ec2_tag"]) {
    const got = scope.checkPlanAws(plan([{ address: `${t}.x`, values: {}, refs: {} }]), ID).filter((p) => p.address === `${t}.x`);
    assert.deepEqual(got.map((p) => p.rule), ["type"], t);
    assert.match(got[0].message, /ruling A48/, t);
    assert.doesNotMatch(got[0].message, /AWS_TYPES: add it/, t);
  }
});

test("a role may trust the lab's own roles in the lab's own account (the boundary's account), and SSM may target the lab by tag (final review, Important 3 and 4)", () => {
  assert.deepEqual(rules(plan([role({ assume_role_policy: trustAws([`arn:aws:iam::${ACCOUNT}:role/cloudlabs-lab/lab-${ID}-vm`]) })])), []);
  const own = (targets) => plan([{ address: "aws_ssm_association.inv", values: tagged(c, { name: "AWS-GatherSoftwareInventory", targets }), refs: {} }]);
  assert.deepEqual(rules(own([{ key: "tag:cloudlabs-lab", values: [ID] }])), []);
  assert.deepEqual(rules(own([{ key: "tag:Patch Group", values: [`lab-${ID}-web`] }])), []);
  const msg = scope.checkPlanAws(own([{ key: "InstanceIds", values: ["*"] }]), ID)[0].message;
  assert.match(msg, /every instance/);
  const trust = scope.checkPlanAws(plan([role({ assume_role_policy: trustAws(`arn:aws:iam::999999999999:role/cloudlabs-lab/lab-${ID}-vm`) })]), ID)[0].message;
  assert.match(trust, /the lab's own account/);
  assert.doesNotMatch(trust, /999999999999|123456789012/, "no account id is printed");
});

test("every rule has at least one evil plan", () => {
  assert.deepEqual([...new Set(EVIL.map(([r]) => r))].sort(), [...scope.AWS_RULES].sort());
});

test("the Config recorder passes in lab 02; the us-east-1 provider passes in lab 09", () => {
  const c2 = ctxAws("soa-02-systems-manager", "02");
  const rec = { address: "aws_config_configuration_recorder.r", values: { name: "lab-soa-02-systems-manager-recorder" }, unknown: ["role_arn"], refs: {} };
  assert.deepEqual(scope.checkPlanAws(realisticPlan({ resources: [...templateResources(c2), rec], data: awsData(), providers: ["aws"], providerConfig: AWS_PROVIDER_CONFIG, variables: c2.variables }), c2.id), []);
  const c9 = ctxAws("soa-09-route53-cloudfront", "09");
  const pc = { ...AWS_PROVIDER_CONFIG, "aws.us_east_1": { name: "aws", full_name: "registry.terraform.io/hashicorp/aws", alias: "us_east_1", expressions: { alias: { constant_value: "us_east_1" }, region: { constant_value: "us-east-1" }, default_tags: [{ tags: { references: ["var.tags"] } }] } } };
  assert.deepEqual(scope.checkPlanAws(realisticPlan({ resources: templateResources(c9), data: awsData(), providers: ["aws"], providerConfig: pc, variables: c9.variables }), c9.id), []);
});

test("a launch template named lt-<name prefix> passes: the known-id check reads id-holding keys only (preflight C4)", () => {
  const specs = ["instance", "volume", "network-interface"].map((t) => ({ resource_type: t, tags: { ...c.tags, Name: "vm-web" } }));
  const lt = { address: "aws_launch_template.web", values: tagged(c, { name: "lt-a03bc1de", image_id: AMI, instance_type: "t4g.micro", metadata_options: [{ http_tokens: "required" }], tag_specifications: specs }), unknown: ["vpc_security_group_ids"], refs: { image_id: ["data.aws_ssm_parameter.al2023_arm64.insecure_value", "data.aws_ssm_parameter.al2023_arm64"], vpc_security_group_ids: ref("aws_security_group.vms", "id") } };
  assert.deepEqual(rules(plan([lt])), []);
  // The same string under an id-holding key names a resource the lab did not make.
  assert.deepEqual(rules(plan([{ ...lt, values: { ...lt.values, vpc_security_group_ids: ["sg-0123456789abcdef0"] }, unknown: [] }])), ["gateway: aws_launch_template.web"]);
});

test("labs 01, 02 and 04's shapes pass: their alarms, associations, run-command targets and backup selections name their own instances by reference (review round 1)", () => {
  const vm = al2023Instance(c, { key: "web", name: "vm-web" });
  const own = ref("aws_instance.web", "id");
  const extra = [
    vm,
    { address: "aws_cloudwatch_metric_alarm.cpu", values: tagged(c, { alarm_name: `lab-${ID}-cpu`, comparison_operator: "GreaterThanThreshold", evaluation_periods: 1, metric_name: "CPUUtilization", namespace: "AWS/EC2", period: 300, statistic: "Average", threshold: 80, dimensions: {} }), unknown: ["dimensions.InstanceId"], refs: { dimensions: own } },
    { address: "aws_ssm_association.by_id", values: tagged(c, { name: "AWS-RunPatchBaseline", targets: [{ key: "InstanceIds" }] }), unknown: ["targets.0.values"], refs: { "targets.0.values": own } },
    { address: "aws_ssm_association.by_tag", values: tagged(c, { name: "AWS-RunPatchBaseline", targets: [{ key: "tag:cloudlabs-lab", values: [ID] }] }), refs: { "targets.0.values": ["var.lab_id"] } },
    { address: "aws_backup_selection.vms", values: { name: "vms", resources: [] }, unknown: ["plan_id", "iam_role_arn", "resources.0"], refs: { plan_id: ref("aws_backup_plan.p", "id"), resources: ref("aws_instance.web", "arn") } },
    { address: "aws_backup_selection.tagged", values: { name: "tagged", selection_tag: [{ type: "STRINGEQUALS", key: "cloudlabs-lab", value: ID }] }, unknown: ["plan_id", "iam_role_arn"], refs: { plan_id: ref("aws_backup_plan.p", "id"), "selection_tag.0.value": ["var.lab_id"] } },
  ];
  assert.deepEqual(rules(plan(extra)), []);
  // Batch 3, ruling P14: an EventBridge target's arn is the lab's own topic, queue, function, state machine, stream or
  // log group by reference, so a run-command target (an SSM document) is refused now, even on the lab's own instance
  // and running as the lab's own role.
  const runCommand = { address: "aws_cloudwatch_event_target.run", values: { arn: "arn:aws:ssm:eu-west-2::document/AWS-RunShellScript", run_command_targets: [{ key: "InstanceIds" }] }, unknown: ["rule", "role_arn", "run_command_targets.0.values"], refs: { role_arn: ref("aws_iam_role.vm", "arn"), "run_command_targets.0.values": own } };
  assert.deepEqual(rules(plan([vm, role(), runCommand])), ["gateway: aws_cloudwatch_event_target.run"]);
  // A role's managed_policy_arns may list MANAGED_POLICIES and the lab's own policies.
  const extraPolicy = policy({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["logs:PutLogEvents"], Resource: "*" }] });
  const r = role({ managed_policy_arns: ["arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"] });
  assert.deepEqual(rules(plan([extraPolicy, { ...r, unknown: ["managed_policy_arns.1"], refs: { managed_policy_arns: ref("aws_iam_policy.extra", "arn") } }])), []);
});

test("the secondary provider passes only when the plan's secondary_region is set and differs from region", () => {
  const sec = { ...AWS_PROVIDER_CONFIG, "aws.secondary": { name: "aws", full_name: "registry.terraform.io/hashicorp/aws", alias: "secondary", expressions: { region: { references: ["var.secondary_region"] }, default_tags: [{ tags: { references: ["var.tags"] } }] } } };
  assert.deepEqual(rules(plan([], { providerConfig: sec, variables: { ...c.variables, secondary_region: "eu-west-1" } })), []);
  assert.deepEqual(rules(plan([], { providerConfig: sec })), ["provider: provider.aws.secondary"], "secondary_region empty");
  assert.deepEqual(rules(plan([], { providerConfig: sec, variables: { ...c.variables, secondary_region: "eu-west-2" } })), ["provider: provider.aws.secondary"], "secondary_region equal to region");
});

test("rule 4 hands IAM users to rule 8 and the peering accepter to rule 9 (preflight C1)", () => {
  const user = { address: "aws_iam_user.u", values: tagged(c, { name: `lab-${ID}-u`, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY }), refs: {} };
  assert.deepEqual(rules(plan([user])), ["iam: aws_iam_user.u"]);
  const c7 = ctxAws("soa-07-iam-kms", "07");
  const user7 = { ...user, values: tagged(c7, { name: "lab-soa-07-iam-kms-u", path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY, force_destroy: true }) };
  assert.deepEqual(rules(realisticPlan({ resources: [...templateResources(c7), user7], data: awsData(), providers: ["aws"], providerConfig: AWS_PROVIDER_CONFIG, variables: c7.variables }), c7.id), [], "soa-07 may make a bounded user");
  assert.deepEqual(rules(realisticPlan({ resources: [...templateResources(c7), { ...user7, values: { ...user7.values, permissions_boundary: null } }], data: awsData(), providers: ["aws"], providerConfig: AWS_PROVIDER_CONFIG, variables: c7.variables }), c7.id), ["iam: aws_iam_user.u"]);
});

test("a lab's own policy may be attached, and a policy document must be known at plan", () => {
  const extra = policy({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["logs:PutLogEvents"], Resource: "*" }] });
  const attach = (arn) => ({ address: "aws_iam_role_policy_attachment.x", values: arn ? { policy_arn: arn } : {}, unknown: ["role", ...(arn ? [] : ["policy_arn"])], refs: { role: ref("aws_iam_role.vm", "name"), ...(arn ? {} : { policy_arn: ref("aws_iam_policy.extra", "arn") }) } });
  assert.deepEqual(rules(plan([role(), extra, attach(null)])), []);
  assert.deepEqual(rules(plan([role(), attach("arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore")])), []);
  const unknownDoc = { ...extra, values: { ...extra.values, policy: undefined }, unknown: ["policy"], refs: { policy: ["aws_s3_bucket.b.arn", "aws_s3_bucket.b"] } };
  delete unknownDoc.values.policy;
  assert.deepEqual(rules(plan([unknownDoc])), ["iam: aws_iam_policy.extra"]);
  assert.match(scope.checkPlanAws(plan([unknownDoc]), ID)[0].message, /known at plan/);
});

test("mock mode: no tags_all and no provider configuration in the stream, still every other rule", () => {
  const p = plan();
  delete p.configuration.provider_config;
  for (const r of p.planned_values.root_module.resources) delete r.values.tags_all;
  const input = { ...planResources(p), configKeys: {}, providerConfigs: {} };
  assert.deepEqual(scope.scopeProblemsAws(input, ID, { mode: "mock" }), []);
  assert.ok(scope.scopeProblemsAws(input, ID, { mode: "plan" }).some((x) => x.rule === "provider"), "plan mode needs the aws provider configured");
  const bad = plan([{ address: "aws_vpc_security_group_ingress_rule.ssh_world", values: tagged(c, { cidr_ipv4: "0.0.0.0/0", ip_protocol: "tcp", from_port: 22, to_port: 22 }), unknown: ["security_group_id"], refs: { security_group_id: ref("aws_security_group.vms", "id") } }]);
  assert.deepEqual(scope.scopeProblemsAws({ ...planResources(bad), configKeys: {}, providerConfigs: {} }, ID, { mode: "mock" }).map((x) => x.rule), ["public"]);
});

test("mock mode: a lab's own policy attachment (unknown policy_arn, no configuration to read) passes; plan mode still reads its references", () => {
  const extra = policy({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["logs:PutLogEvents"], Resource: "*" }] });
  const attach = { address: "aws_iam_role_policy_attachment.x", values: { role: `lab-${ID}-vm` }, unknown: ["policy_arn"], refs: { role: ref("aws_iam_role.vm", "name"), policy_arn: ref("aws_iam_policy.extra", "arn") } };
  const p = plan([role(), extra, attach]);
  const noRefs = { ...planResources(p), configKeys: {}, providerConfigs: {} };
  for (const r of noRefs.resources) if (r.address === "aws_iam_role_policy_attachment.x") { r.refs = {}; for (const v of Object.values(r.values)) if (v?.refs) v.refs = []; }
  assert.deepEqual(scope.scopeProblemsAws(noRefs, ID, { mode: "mock" }).filter((x) => x.address === "aws_iam_role_policy_attachment.x"), []);
  const foreign = { ...attach, refs: { role: attach.refs.role, policy_arn: ref("aws_s3_bucket.b", "arn") } };
  assert.deepEqual(rules(plan([role(), extra, foreign])), ["iam: aws_iam_role_policy_attachment.x"]);
  // Mock mode still refuses a literal ARN off the managed list and an unknown ARN whose references are a foreign resource.
  const mockRules = (resources) => scope.scopeProblemsAws({ ...planResources(plan(resources)), configKeys: {}, providerConfigs: {} }, ID, { mode: "mock" }).filter((x) => x.address === "aws_iam_role_policy_attachment.x").map((x) => x.rule);
  assert.deepEqual(mockRules([role(), extra, { ...attach, values: { role: `lab-${ID}-vm`, policy_arn: "arn:aws:iam::aws:policy/AdministratorAccess" }, unknown: [], refs: { role: attach.refs.role } }]), ["iam"]);
  assert.deepEqual(mockRules([role(), extra, foreign]), ["iam"]);
});

test("HCL: the provider blocks as §4 pass; credentials, another region and other default tags are refused", () => {
  const hcl = (provider, resource = {}) => ({
    terraform: [{ required_providers: [{ aws: { source: "hashicorp/aws", version: "~> 6.0" } }] }],
    provider: { aws: provider },
    resource: { aws_vpc: { lab: [{ cidr_block: "${local.vpc_cidr}", tags: { Name: "vpc-lab" } }] }, ...resource },
  });
  const ok = [{ region: "${var.region}", default_tags: [{ tags: "${var.tags}" }] }];
  const secondary = { alias: "secondary", region: "${var.secondary_region}", default_tags: [{ tags: "${var.tags}" }] };
  const h = (x, id = ID) => scope.checkHclAws(x, id).map((p) => `${p.rule}: ${p.address}`);
  assert.deepEqual(h(hcl(ok)), []);
  assert.deepEqual(h(hcl([...ok, secondary])), []);
  assert.deepEqual(h(hcl([{ ...ok[0], profile: "admin" }])), ["provider: provider.aws"]);
  assert.deepEqual(h(hcl([{ ...ok[0], region: "us-east-1" }])), ["provider: provider.aws"]);
  assert.deepEqual(h(hcl([...ok, { alias: "use1", region: "us-east-1", default_tags: [{ tags: "${var.tags}" }] }]), "soa-09-route53-cloudfront"), []);
  assert.deepEqual(h(hcl([{ ...ok[0], default_tags: [{ tags: { owner: "me" } }] }])), ["provider: provider.aws"]);
  // An untaggable name built from var.lab_id counts; a literal one is refused.
  assert.deepEqual(h(hcl(ok, { aws_cloudwatch_dashboard: { d: [{ dashboard_name: "lab-${var.lab_id}-overview", dashboard_body: "{}" }] } })), []);
  assert.deepEqual(h(hcl(ok, { aws_cloudwatch_dashboard: { d: [{ dashboard_name: "overview", dashboard_body: "{}" }] } })), ["untaggable: aws_cloudwatch_dashboard.d"]);
});

test("the command line: exit 0 for the template, 1 with one line per refusal, 2 for bad arguments", () => {
  const dir = mkdtempSync(join(tmpdir(), "scope-aws-"));
  const good = join(dir, "good.json");
  const bad = join(dir, "bad.json");
  writeFileSync(good, JSON.stringify(plan()));
  writeFileSync(bad, JSON.stringify(EVIL.find(([, w]) => w === "SSH from the internet")[2]()));
  const run = (...a) => spawnSync(process.execPath, ["infra/ci/lab-scope-aws.mjs", ...a], { encoding: "utf8" });
  assert.equal(run("--plan", good, "--lab", ID).status, 0);
  const r = run("--plan", bad, "--lab", ID);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^public: aws_vpc_security_group_ingress_rule\.ssh_world \(/m);
  assert.equal(run("--plan", good).status, 2);
  assert.equal(run("--plan", good, "--lab", "az104-08-vms").status, 2, "an Azure id is refused: this is the AWS check");
});

test("an instance tags its volumes with volume_tags (var.tags alone is enough); root_block_device tags never stand in (final review, Important 1)", () => {
  // volume_tags = var.tags with no Name (lab 04: a separately attached disk then carries the very same tags).
  assert.deepEqual(rules(plan([al2023Instance(c, { key: "data", name: "vm-data", volumeName: null })])), []);
  // The provider applies root_block_device.tags after launch, so RunInstances would carry no volume tag and
  // wg-admin-labs's CreateNeedsLabTagRunInstances would refuse it: the plan is refused first.
  const rootOnly = al2023Instance(c, { key: "data", name: "vm-data" });
  delete rootOnly.values.volume_tags;
  rootOnly.values.root_block_device[0].tags = { ...c.tags, Name: "vm-data" };
  assert.deepEqual(rules(plan([rootOnly])), ["tag: aws_instance.data"]);
  assert.match(scope.checkPlanAws(plan([rootOnly]), ID)[0].message, /volume_tags must carry cloudlabs-lab/);
});

test("ruling P9: the instance-target allow-list passes soa-02's targets and refuses every other selector", () => {
  const own = (targets) => rules(plan([{ address: "aws_ssm_association.x", values: tagged(c, { name: "AWS-RunShellScript", targets }), refs: {} }]));
  for (const t of [[{ key: "tag:cloudlabs-lab", values: [ID] }], [{ key: "tag:Patch Group", values: [`lab-${ID}-web`] }], [{ key: "resource-groups:Name", values: [`lab-${ID}`] }]]) assert.deepEqual(own(t), [], JSON.stringify(t));
  for (const t of [[{ key: "tag:Patch Group", values: ["web"] }], [{ key: "tag:cloudlabs-lab", values: ["soa-02-systems-manager"] }], [{ key: "tag:Name", values: [`lab-${ID}-*`] }], [{ key: "resource-groups:Name", values: ["lab-soa-02-systems-manager"] }], [{ key: "ParameterValues", values: ["x"] }]]) assert.deepEqual(own(t), ["gateway: aws_ssm_association.x"], JSON.stringify(t));
});

test("ruling P7: in lab 09 only a WAF web ACL for CloudFront may live in us-east-1; CloudFront and Route 53 carry no region", () => {
  const waf = (aclScope) => scope.checkPlanAws(plan9([{ address: "aws_wafv2_web_acl.w", values: tagged(c9, { name: "lab-soa-09-route53-cloudfront-w", scope: aclScope, region: "us-east-1" }), refs: {} }]), c9.id).map((x) => x.rule);
  assert.ok(!waf("CLOUDFRONT").includes("provider"), "a CloudFront WAF may be in us-east-1 (its type is batch 4's to list)");
  assert.ok(waf("REGIONAL").includes("provider"));
  const cf = realisticPlan({ resources: [{ address: "aws_cloudfront_distribution.d", values: tagged(c9, { enabled: true }), refs: {} }], providers: ["aws"], providerConfig: AWS_PROVIDER_CONFIG, variables: c9.variables });
  assert.equal(cf.resource_changes.find((x) => x.address === "aws_cloudfront_distribution.d").change.after.region, undefined, "global types have no region of their own (computed.json)");
});

test("ruling P10: a bucket policy for CloudFront and soa-01's topic policy pass; an unknown one is refused", () => {
  const p = (doc, unknown = []) => rules(plan([{ address: "aws_s3_bucket_policy.p", values: doc === null ? {} : { policy: JSON.stringify(doc) }, unknown: ["bucket", ...unknown], refs: {} }]));
  assert.deepEqual(p({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "cloudfront.amazonaws.com" }, Action: "s3:GetObject", Resource: `arn:aws:s3:::cloudlabs-${c.prefix}-site/*`, Condition: { ArnLike: { "AWS:SourceArn": `arn:aws:cloudfront::${ACCOUNT}:distribution/*` } } }] }), []);
  assert.deepEqual(p({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: `arn:aws:iam::${ACCOUNT}:root` }, Action: "s3:*", Resource: "*" }, { Effect: "Deny", Principal: "*", Action: "s3:*", Resource: "*", Condition: { Bool: { "aws:SecureTransport": "false" } } }] }), []);
  assert.deepEqual(p(null, ["policy"]), ["public: aws_s3_bucket_policy.p"]);
});

test("ruling P4: cfnTemplateProblems reads a parameter's value through Ref, and a clean template has no problems", () => {
  const doc = { Parameters: { LogGroupName: { Type: "String" } }, Resources: { L: { Type: "AWS::Logs::LogGroup", Properties: { LogGroupName: { Ref: "LogGroupName" }, RetentionInDays: 1 } }, Q: { Type: "AWS::SQS::Queue" } } };
  assert.deepEqual(scope.cfnTemplateProblems(doc, { labId: ID, parameters: { LogGroupName: `/cloudlabs/${ID}/stack` } }), []);
  assert.deepEqual(scope.cfnTemplateProblems(doc, { labId: ID, parameters: { LogGroupName: "/cloudlabs/soa-02-systems-manager/x" } }), [`L: LogGroupName must start /cloudlabs/${ID}/ (a literal or a Ref to a stack parameter; ruling A56)`]);
});

test("ruling P4: a stack with its own service role and a clean template passes", () => {
  assert.deepEqual(rules(stackPlan({})), []);
});

test("ruling P8: lab 09's zone, its distribution in front of its own bucket (the origin access control beside it) and a health check of its own distribution pass (preflight C2)", () => {
  const bucket = { address: "aws_s3_bucket.site", values: tagged(c9, { bucket: `cloudlabs-${c9.prefix}-site`, force_destroy: true }), refs: { bucket: ["var.name_prefix"] } };
  const oac = { address: "aws_cloudfront_origin_access_control.site", values: { name: "lab-soa-09-route53-cloudfront-site", origin_access_control_origin_type: "s3", signing_behavior: "always", signing_protocol: "sigv4" }, refs: { name: ["var.lab_id"] } };
  const dist = (domain) => ({
    address: "aws_cloudfront_distribution.site",
    values: tagged(c9, { enabled: true, price_class: "PriceClass_100", retain_on_delete: false, origin: [{ origin_id: "site", ...(domain ? { domain_name: domain } : {}) }] }),
    unknown: [...(domain ? [] : ["origin.0.domain_name"]), "origin.0.origin_access_control_id"],
    refs: { ...(domain ? {} : { "origin.0.domain_name": ref("aws_s3_bucket.site", "bucket_regional_domain_name") }), "origin.0.origin_access_control_id": ref("aws_cloudfront_origin_access_control.site", "id") },
  });
  const zone = (name) => ({ address: "aws_route53_zone.lab", values: tagged(c9, { name, force_destroy: true }), refs: { name: ["var.name_prefix"] } });
  const check = { address: "aws_route53_health_check.site", values: tagged(c9, { type: "HTTP", port: 80, resource_path: "/health.html", request_interval: 30, failure_threshold: 3 }), unknown: ["fqdn"], refs: { fqdn: ref("aws_cloudfront_distribution.site", "domain_name") } };
  const r9 = (extra) => rules(plan9(extra), c9.id);
  assert.deepEqual(r9([bucket, oac, dist(null), zone(`${c9.prefix}.labs.clydeford.net`), check]), []);
  assert.deepEqual(r9([bucket, oac, dist("www.example.com")]), ["gateway: aws_cloudfront_distribution.site"], "a distribution in front of someone else's site");
  assert.deepEqual(r9([zone(`${c7.prefix}.labs.clydeford.net`)]), ["gateway: aws_route53_zone.lab"], "another session's zone name");
});

test("ruling P10, mock mode: with no caller identity in the stream, the lab's own account is its roles' boundary's (labs-tf on soa-01)", () => {
  const topicPolicy = (principal) => ({ address: "aws_sns_topic_policy.p", values: { policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: principal }, Action: "sns:Publish", Resource: "*" }] }) }, unknown: ["arn"], refs: {} });
  const mock = (extra) => {
    const input = { ...planResources(plan(extra)), configKeys: {}, providerConfigs: {} };
    input.resources = input.resources.filter((r) => r.mode !== "data");
    return scope.scopeProblemsAws(input, ID, { mode: "mock" }).map((x) => `${x.rule}: ${x.address}`);
  };
  assert.deepEqual(mock([role(), topicPolicy(`arn:aws:iam::${ACCOUNT}:root`)]), []);
  assert.deepEqual(mock([role(), topicPolicy("arn:aws:iam::999999999999:root")]), ["public: aws_sns_topic_policy.p"]);
  assert.deepEqual(mock([topicPolicy(`arn:aws:iam::${ACCOUNT}:root`)]), ["public: aws_sns_topic_policy.p"], "no account to read: refused");
});

test("review C-1: the lab's group selects only its own tag, known at plan, so resource-groups:Name = lab-<id> selects only the lab", () => {
  const gate = (base) => rules(plan([], { base }));
  assert.deepEqual(gate(templateResources(c)), [], "the template's group (any ResourceTypeFilters, TagFilters cloudlabs-lab = the id)");
  assert.deepEqual(gate(groupBase({ ResourceTypeFilters: ["AWS::EC2::Instance"], TagFilters: [{ Key: "cloudlabs-lab", Values: [ID] }] })), []);
  for (const q of [{ ResourceTypeFilters: ["AWS::AllSupported"], TagFilters: [{ Key: "run_id" }] }, { ResourceTypeFilters: ["AWS::AllSupported"], TagFilters: [{ Key: "cloudlabs-lab", Values: [ID, "soa-02-systems-manager"] }] }, { ResourceTypeFilters: ["AWS::AllSupported"], TagFilters: [{ Key: "cloudlabs-lab", Values: [ID] }, { Key: "Name", Values: ["vm-x"] }] }, { ResourceTypeFilters: ["AWS::AllSupported"] }]) {
    assert.deepEqual(gate(groupBase(q)), ["gateway: aws_resourcegroups_group.lab"], JSON.stringify(q));
  }
  const unknownQuery = templateResources(c);
  unknownQuery[0] = { ...unknownQuery[0], values: { ...unknownQuery[0].values, resource_query: [{ type: "TAG_FILTERS_1_0" }] }, unknown: ["resource_query.0.query"], refs: {} };
  assert.deepEqual(gate(unknownQuery), ["gateway: aws_resourcegroups_group.lab"], "a query not known at plan");
  const otherName = templateResources(c);
  otherName[0] = { ...otherName[0], values: { ...otherName[0].values, name: `lab-${ID}-all` } };
  assert.deepEqual(gate(otherName), ["gateway: aws_resourcegroups_group.lab"], "a group not named lab-<id>");
});

test("review I-4: a stack's parameters known at plan are what its template is judged with", () => {
  const body = JSON.stringify({ Parameters: { N: { Type: "String", Default: `/cloudlabs/${ID}/x` } }, Resources: { L: { Type: "AWS::Logs::LogGroup", Properties: { LogGroupName: { Ref: "N" }, RetentionInDays: 1 } } } });
  assert.deepEqual(rules(stackPlan({ template_body: body, parameters: { N: `/cloudlabs/${ID}/y` } })), []);
  assert.deepEqual(rules(stackPlan({ template_body: body, parameters: { N: "/aws/other" } })), ["template: aws_cloudformation_stack.lab"]);
});

test("re-review N-1: lab 06's planned template passes, judged by its shape (Ref and Fn::GetAtt only, String and Number parameters, alarm actions its own topic)", () => {
  assert.deepEqual(scope.cfnTemplateProblems(LAB06_TEMPLATE, { labId: ID, parameters: LAB06_PARAMETERS }), []);
  assert.deepEqual(rules(stackPlan({ template_body: JSON.stringify(LAB06_TEMPLATE), parameters: LAB06_PARAMETERS })), []);
  const why = (doc) => scope.cfnTemplateProblems(doc, { labId: ID, parameters: LAB06_PARAMETERS });
  const withAlarm = (actions) => ({ ...LAB06_TEMPLATE, Resources: { ...LAB06_TEMPLATE.Resources, OldestMessageAlarm: { ...LAB06_TEMPLATE.Resources.OldestMessageAlarm, Properties: { ...LAB06_TEMPLATE.Resources.OldestMessageAlarm.Properties, AlarmActions: actions } } } });
  assert.equal(why(withAlarm([{ Ref: "WorkQueue" }])).length, 1, "a queue is not a topic");
  assert.equal(why(withAlarm([{ Ref: "Nowhere" }])).length, 1, "a Ref to nothing in the template");
  assert.equal(why(withAlarm(["arn:aws:sns:eu-west-2:123456789012:other"])).length, 1, "a literal ARN");
  assert.deepEqual(why(withAlarm([{ Ref: "AlertTopic" }])), []);
});

test("re-review N-2: an alarm notifying the lab's own topic passes; its dimension by the lab's own instance passes", () => {
  const topic = { address: "aws_sns_topic.t", values: tagged(c, { name: `lab-${ID}-t` }), refs: {} };
  const vm = al2023Instance(c, { key: "web", name: "vm-web" });
  assert.deepEqual(rules(plan([topic, vm, { ...ALARM, values: { ...ALARM.values, dimensions: {} }, unknown: ["alarm_actions", "ok_actions", "dimensions.InstanceId"], refs: { alarm_actions: ref("aws_sns_topic.t", "arn"), ok_actions: ref("aws_sns_topic.t", "arn"), dimensions: ref("aws_instance.web", "id") } }])), []);
});

test("a Lambda permission's function_url_auth_type: NONE is refused; unset (null, not configured) passes; configured null is refused (lab 07 fix round 1)", () => {
  // Batch 3, ruling P13: the permission names its source, the lab's own secret by reference (as lab 07's does).
  const secret = { address: "aws_secretsmanager_secret.app", values: tagged(c7, { name: "lab-soa-07-iam-kms-app", recovery_window_in_days: 0 }), refs: {} };
  const perm = (v, refs = {}) => ({ address: "aws_lambda_permission.p", values: { action: "lambda:InvokeFunction", principal: "secretsmanager.amazonaws.com", statement_id: "x", ...v }, unknown: ["function_name", "source_arn"], refs: { source_arn: ref("aws_secretsmanager_secret.app", "arn"), ...refs } });
  const pub = (p) => rules(p, "soa-07-iam-kms").filter((r) => r.startsWith("public"));
  assert.equal(pub(plan7([secret, perm({ function_url_auth_type: "NONE" })])).length, 1, "NONE");
  // realisticPlan treats every key in values as configured, so the unset case is made by printing the null into the finished plan, as Terraform does.
  const unset = plan7([secret, perm({})]);
  const printNull = (o) => { if (o && typeof o === "object") { if (o.address === "aws_lambda_permission.p") { if (o.values) o.values.function_url_auth_type = null; if (o.change?.after) o.change.after.function_url_auth_type = null; } Object.values(o).forEach(printNull); } };
  printNull(unset);
  assert.deepEqual(pub(unset), [], "unset: a plan prints null, nothing configured");
  // An attribute the configuration sets to null is still refused: it is configured and not AWS_IAM (conservative).
  assert.equal(pub(plan7([secret, perm({ function_url_auth_type: null }, { function_url_auth_type: ["var.x"] })])).length, 1, "configured null");
});

test("an ECS task definition: an unset task role is no role (null passes); an unknown role with no reference, a literal ARN and a non-role reference are refused", () => {
  const tdLogs = { address: "aws_cloudwatch_log_group.t", values: tagged(c, { name: `/cloudlabs/${ID}/t`, retention_in_days: 1, skip_destroy: false }), refs: {} };
  const td = (over, unknown = ["execution_role_arn"], refs = { execution_role_arn: ref("aws_iam_role.vm", "arn") }) => ({
    address: "aws_ecs_task_definition.t",
    values: tagged(c, { family: `lab-${ID}-t`, requires_compatibilities: ["FARGATE"], network_mode: "awsvpc", cpu: "256", memory: "512", container_definitions: JSON.stringify([{ name: "t", image: "x", logConfiguration: { logDriver: "awslogs", options: { "awslogs-group": `/cloudlabs/${ID}/t` } } }]), ...over }),
    unknown,
    refs,
  });
  const both = (task) => ({ execution_role_arn: ref("aws_iam_role.vm", "arn"), ...task });
  assert.deepEqual(rules(plan([role(), tdLogs, td({})])), [], "an unset task role prints as null in a plan");
  assert.deepEqual(rules(plan([role(), tdLogs, td({}, ["execution_role_arn", "task_role_arn"], both({ task_role_arn: ref("aws_iam_role.vm", "arn") }))])), [], "the lab's own role by reference");
  assert.deepEqual(rules(plan([role(), tdLogs, td({}, ["execution_role_arn", "task_role_arn"], both({}))])), ["iam: aws_ecs_task_definition.t"], "unknown with no reference");
  assert.deepEqual(rules(plan([role(), tdLogs, td({ task_role_arn: `arn:aws:iam::${ACCOUNT}:role/someone-else` })])), ["iam: aws_ecs_task_definition.t"], "a foreign role by ARN");
  assert.deepEqual(rules(plan([role(), tdLogs, td({}, ["execution_role_arn", "task_role_arn"], both({ task_role_arn: ref("aws_iam_user.u", "arn") }))])), ["iam: aws_ecs_task_definition.t"], "a reference that is not a lab role");
});

// ── Batch 3 (labs 11–19) ──

const c11 = ctxAws("saa-11-three-tier", "11");
const c12 = ctxAws("saa-12-serverless-api", "12");
const c13 = ctxAws("saa-13-decoupling", "13");
const c15 = ctxAws("saa-15-data-security", "15");
const c16b = ctxAws("saa-16-dr-pilot-light", "16");
const c16 = { ...c16b, variables: { ...c16b.variables, secondary_region: "eu-west-1" } };
const c17 = ctxAws("saa-17-data-pipeline", "17");
const c19 = ctxAws("saa-19-eks", "19");
const T = (cx, address, values, more = {}) => ({ address, values: tagged(cx, values), refs: {}, ...more });
const U = (address, values, more = {}) => ({ address, values, refs: {}, ...more });
const rulesFor = (cx, extra, base) => rules(realisticPlan({ resources: [...(base ?? templateMainResources(cx)), ...extra], data: awsData(), providers: ["aws"], providerConfig: AWS_PROVIDER_CONFIG, variables: cx.variables }), cx.id);
const DB = { identifier: "db-a11k3x9q", engine: "mysql", instance_class: "db.t4g.micro", allocated_storage: 20, skip_final_snapshot: true, deletion_protection: false, delete_automated_backups: true, copy_tags_to_snapshot: true, db_subnet_group_name: "lab-saa-11-three-tier-db" };

test("rulings P16 and P13: refuses a public database and a Lambda permission with no own source; an own rule passes", () => {
  assert.deepEqual(rulesFor(c11, [dbGroup(c11), T(c11, "aws_db_instance.app", { ...DB, publicly_accessible: true })], templateResources(c11)), ["public: aws_db_instance.app"]);
  assert.deepEqual(rulesFor(c11, [dbGroup(c11), T(c11, "aws_db_instance.app", { ...DB, publicly_accessible: false })], templateResources(c11)), []);
  const rule = T(c17, "aws_cloudwatch_event_rule.tick", { name: "lab-saa-17-data-pipeline-tick", schedule_expression: "rate(1 minute)" });
  const perm = (over) => U("aws_lambda_permission.tick", { statement_id: "events", action: "lambda:InvokeFunction", function_name: "lab-saa-17-data-pipeline-producer", principal: "events.amazonaws.com", ...over.values }, over.more ?? {});
  assert.deepEqual(rulesFor(c17, [rule, perm({ values: {} })]), ["public: aws_lambda_permission.tick"]);
  assert.deepEqual(rulesFor(c17, [rule, perm({ values: {}, more: { unknown: ["source_arn"], refs: { source_arn: ref("aws_cloudwatch_event_rule.tick", "arn") } } })]), []);
});

test("Review Focus 5 / P14: refuses a target, subscription, workflow, stream or path outside the lab", () => {
  const other = "arn:aws:sqs:eu-west-2:999999999999:theirs";
  assert.deepEqual(rulesFor(c13, [U("aws_cloudwatch_event_target.x", { rule: "lab-saa-13-decoupling-placed", target_id: "x", arn: other })]), ["gateway: aws_cloudwatch_event_target.x"]);
  assert.deepEqual(rulesFor(c13, [U("aws_sns_topic_subscription.x", { protocol: "https", endpoint: "https://example.com/hook" }, { unknown: ["topic_arn"], refs: { topic_arn: ref("aws_sns_topic.orders", "arn") } }), T(c13, "aws_sns_topic.orders", { name: "lab-saa-13-decoupling-orders" })]), ["gateway: aws_sns_topic_subscription.x"]);
  const wf = (Resource) => JSON.stringify({ StartAt: "A", States: { A: { Type: "Task", Resource, End: true } } });
  const sm = (def) => T(c13, "aws_sfn_state_machine.orders", { name: "lab-saa-13-decoupling-orders", type: "STANDARD", definition: def }, { unknown: ["role_arn"], refs: { role_arn: ref("aws_iam_role.sfn", "arn") } });
  const sfnRole = { ...role({ name: "lab-saa-13-decoupling-sfn", assume_role_policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "states.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }), address: "aws_iam_role.sfn", values: tagged(c13, { name: "lab-saa-13-decoupling-sfn", path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY, assume_role_policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "states.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }) };
  assert.deepEqual(rulesFor(c13, [sfnRole, sm(wf("arn:aws:states:::aws-sdk:iam:createUser"))]), ["gateway: aws_sfn_state_machine.orders"]);
  assert.deepEqual(rulesFor(c13, [sfnRole, sm(wf(`arn:aws:lambda:eu-west-2:${ACCOUNT}:function:lab-saa-13-decoupling-validate`))]), []);
  assert.equal(scope.workflowProblem({ States: { A: { Type: "Task", Resource: "arn:aws:states:::sns:publish", Parameters: { TopicArn: "arn:aws:sns:eu-west-2:1:someone" } } } }, "saa-13-decoupling") !== null, true);
  const svcRole = (cx, key, name, svc) => ({ address: `aws_iam_role.${key}`, values: tagged(cx, { name, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY, assume_role_policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: `${svc}.amazonaws.com` }, Action: "sts:AssumeRole" }] }) }), refs: {} });
  const crawlerRole = svcRole(c17, "crawler", "lab-saa-17-data-pipeline-crawler", "glue");
  const crawler = (path) => T(c17, "aws_glue_crawler.events", { name: "lab-saa-17-data-pipeline-events", database_name: "lab_saa_17_data_pipeline", s3_target: [{ path }] }, { unknown: ["role"], refs: { role: ref("aws_iam_role.crawler", "arn") } });
  assert.deepEqual(rulesFor(c17, [crawlerRole, crawler("s3://cloudlabs-a17k3x9q-lake/events/")]), []);
  assert.deepEqual(rulesFor(c17, [crawlerRole, crawler("s3://someone-else/events/")]), ["gateway: aws_glue_crawler.events"]);
  assert.deepEqual(rulesFor(c17, [T(c17, "aws_athena_workgroup.wg", { name: "lab-saa-17-data-pipeline-wg", force_destroy: true, configuration: [{ enforce_workgroup_configuration: true, bytes_scanned_cutoff_per_query: 10485760, result_configuration: [{ output_location: "s3://someone-else/results/" }] }] })]), ["gateway: aws_athena_workgroup.wg"]);
  const fhRole = svcRole(c17, "firehose", "lab-saa-17-data-pipeline-firehose", "firehose");
  const fhRefs = { unknown: ["kinesis_source_configuration.0.role_arn", "extended_s3_configuration.0.role_arn"], refs: { "kinesis_source_configuration.0.role_arn": ref("aws_iam_role.firehose", "arn"), "extended_s3_configuration.0.role_arn": ref("aws_iam_role.firehose", "arn") } };
  assert.deepEqual(rulesFor(c17, [fhRole, T(c17, "aws_kinesis_firehose_delivery_stream.x", { name: "lab-saa-17-data-pipeline-to-s3", destination: "extended_s3", kinesis_source_configuration: [{ kinesis_stream_arn: "arn:aws:kinesis:eu-west-2:999999999999:stream/theirs" }], extended_s3_configuration: [{ bucket_arn: "arn:aws:s3:::someone-else" }] }, fhRefs)]), ["gateway: aws_kinesis_firehose_delivery_stream.x"]);
});

test("ruling P6: refuses a private zone on another VPC or with a real name, and a health check on another alarm", () => {
  const zone = (over, more = {}) => T(c16, "aws_route53_zone.dr", { name: "dr.a16k3x9q.internal", force_destroy: true, vpc: [{ vpc_region: "eu-west-2" }], ...over }, { unknown: ["vpc.0.vpc_id"], refs: { "vpc.0.vpc_id": ref("aws_vpc.lab", "id") }, ...more });
  assert.deepEqual(rulesFor(c16, [zone({})], templateResources(c16)), []);
  assert.deepEqual(rulesFor(c16, [zone({ name: "corp.example.com" })], templateResources(c16)), ["gateway: aws_route53_zone.dr"]);
  assert.deepEqual(rulesFor(c16, [zone({ vpc: [{ vpc_id: "vpc-0123456789abcdef0", vpc_region: "eu-west-2" }] }, { unknown: [], refs: {} })], templateResources(c16)), ["gateway: aws_route53_zone.dr"]);
  assert.deepEqual(rulesFor(c16, [zone({ vpc: [{ vpc_region: "us-east-2" }] })], templateResources(c16)), ["provider: aws_route53_zone.dr"]);
  const hc = (name) => T(c16, "aws_route53_health_check.app", { type: "CLOUDWATCH_METRIC", cloudwatch_alarm_name: name, cloudwatch_alarm_region: "eu-west-2", insufficient_data_health_status: "Healthy" });
  assert.deepEqual(rulesFor(c16, [hc("lab-saa-16-dr-pilot-light-app-down")]), []);
  assert.deepEqual(rulesFor(c16, [hc("someone-elses-alarm")]), ["gateway: aws_route53_health_check.app"]);
});

test("ruling P18: refuses an endpoint policy allowing another bucket; the lab's buckets and AL2023's repositories pass", () => {
  const pol = (Resource) => JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:*", Resource }] });
  const ep = (Resource) => U("aws_vpc_endpoint_policy.s3", { policy: pol(Resource) }, { unknown: ["vpc_endpoint_id"], refs: { vpc_endpoint_id: ref("aws_vpc_endpoint.s3", "id") } });
  assert.deepEqual(rulesFor(c15, [ep(["arn:aws:s3:::cloudlabs-a15k3x9q-data", "arn:aws:s3:::cloudlabs-a15k3x9q-data/*", "arn:aws:s3:::al2023-repos-eu-west-2-de612dc2/*"])], templateResources(c15)), []);
  assert.deepEqual(rulesFor(c15, [ep(["arn:aws:s3:::*"])], templateResources(c15)), ["public: aws_vpc_endpoint_policy.s3"]);
  assert.match(scope.endpointPolicyProblem({ Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:*", NotResource: "arn:aws:s3:::x" }] }, "a15k3x9q", "eu-west-2"), /NotResource/);
});

test("Review Focus 1: a DynamoDB table or an AMI copy not named lab-<id>-*, a copy of anything but the public parameter, a misnamed Glue database are refused", () => {
  const table = (name, extra = {}) => T(c16, "aws_dynamodb_table.orders", { name, billing_mode: "PAY_PER_REQUEST", hash_key: "id", deletion_protection_enabled: false, ...extra });
  assert.deepEqual(rulesFor(c16, [table("orders")]), ["untaggable: aws_dynamodb_table.orders"]);
  assert.deepEqual(rulesFor(c16, [table("lab-saa-16-dr-pilot-light-orders", { replica: [{ region_name: "eu-west-1", propagate_tags: true }] })]), []);
  assert.deepEqual(rulesFor(c16, [table("lab-saa-16-dr-pilot-light-orders", { replica: [{ region_name: "us-east-2", propagate_tags: true }] })]), ["provider: aws_dynamodb_table.orders"]);
  assert.deepEqual(rulesFor(c16, [table("lab-saa-16-dr-pilot-light-orders", { replica: [{ region_name: "eu-west-1", propagate_tags: false }] })]), ["tag: aws_dynamodb_table.orders"]);
  assert.deepEqual(rulesFor(c16, [table("lab-saa-16-dr-pilot-light-orders", { billing_mode: "PROVISIONED" })]), ["size: aws_dynamodb_table.orders"]);
  const copy = (name, src) => T(c16, "aws_ami_copy.dr", { name, source_ami_id: src, source_ami_region: "eu-west-2" });
  assert.deepEqual(rulesFor(c16, [copy("lab-saa-16-dr-pilot-light-al2023", AMI)], templateResources(c16)), []);
  assert.deepEqual(rulesFor(c16, [copy("al2023-copy", AMI)], templateResources(c16)), ["untaggable: aws_ami_copy.dr"]);
  assert.deepEqual(rulesFor(c16, [copy("lab-saa-16-dr-pilot-light-al2023", "ami-0fedcba9876543210")], templateResources(c16)), ["gateway: aws_ami_copy.dr"]);
  assert.deepEqual(rulesFor(c17, [T(c17, "aws_glue_catalog_database.lake", { name: "events" })]), ["untaggable: aws_glue_catalog_database.lake"]);
  assert.deepEqual(rulesFor(c17, [T(c17, "aws_glue_catalog_database.lake", { name: "lab_saa_17_data_pipeline" })]), []);
});

test("ruling P12: API Gateway and Cognito: an HTTP proxy, an authoriser on another pool, an unthrottled stage, a PLUS pool are refused", () => {
  const api = T(c12, "aws_apigatewayv2_api.lab", { name: "lab-saa-12-serverless-api", protocol_type: "HTTP" });
  const apiRef = { unknown: ["api_id"], refs: { api_id: ref("aws_apigatewayv2_api.lab", "id") } };
  assert.deepEqual(rulesFor(c12, [api, U("aws_apigatewayv2_integration.x", { integration_type: "HTTP_PROXY", integration_uri: "https://example.com", integration_method: "ANY" }, apiRef)]), ["gateway: aws_apigatewayv2_integration.x"]);
  assert.deepEqual(rulesFor(c12, [api, U("aws_apigatewayv2_authorizer.jwt", { authorizer_type: "JWT", name: "cognito", identity_sources: ["$request.header.Authorization"], jwt_configuration: [{ issuer: "https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_Theirs", audience: ["their-client"] }] }, apiRef)]), ["gateway: aws_apigatewayv2_authorizer.jwt"]);
  assert.deepEqual(rulesFor(c12, [api, T(c12, "aws_apigatewayv2_stage.default", { name: "$default", auto_deploy: true }, apiRef)]), ["size: aws_apigatewayv2_stage.default"]);
  assert.deepEqual(rulesFor(c12, [api, T(c12, "aws_apigatewayv2_stage.default", { name: "$default", auto_deploy: true, default_route_settings: [{ throttling_burst_limit: 10, throttling_rate_limit: 5 }] }, apiRef)]), []);
  assert.deepEqual(rulesFor(c12, [T(c12, "aws_cognito_user_pool.users", { name: "lab-saa-12-serverless-api-users", user_pool_tier: "PLUS", deletion_protection: "INACTIVE" })]), ["size: aws_cognito_user_pool.users"]);
  assert.deepEqual(rulesFor(c12, [T(c12, "aws_cognito_user_pool.users", { name: "lab-saa-12-serverless-api-users", user_pool_tier: "LITE", deletion_protection: "ACTIVE" })]), ["lingering: aws_cognito_user_pool.users"]);
});

test("Review Focus 3: EKS: refuses creator admin, extended support, control-plane logs, another node size and a node group over 2", () => {
  const cluster = (over = {}) => T(c19, "aws_eks_cluster.lab", { name: "lab-saa-19-eks", access_config: [{ authentication_mode: "API", bootstrap_cluster_creator_admin_permissions: false }], upgrade_policy: [{ support_type: "STANDARD" }], vpc_config: [{ endpoint_private_access: true, endpoint_public_access: true }], ...over }, { unknown: ["role_arn", "vpc_config.0.subnet_ids"], refs: { role_arn: ref("aws_iam_role.cluster", "arn"), "vpc_config.0.subnet_ids": ["aws_subnet.private"] } });
  const crole = { ...role(), address: "aws_iam_role.cluster", values: tagged(c19, { name: "lab-saa-19-eks-cluster", path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY, assume_role_policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "eks.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }) };
  const base = templateResources(c19);
  assert.deepEqual(rulesFor(c19, [crole, cluster()], base), []);
  assert.deepEqual(rulesFor(c19, [crole, cluster({ access_config: [{ authentication_mode: "API", bootstrap_cluster_creator_admin_permissions: true }] })], base), ["iam: aws_eks_cluster.lab"]);
  assert.deepEqual(rulesFor(c19, [crole, cluster({ upgrade_policy: [{ support_type: "EXTENDED" }] })], base), ["size: aws_eks_cluster.lab"]);
  assert.deepEqual(rulesFor(c19, [crole, cluster({ enabled_cluster_log_types: ["api", "audit"] })], base), ["lingering: aws_eks_cluster.lab"]);
  const ng = (over = {}) => T(c19, "aws_eks_node_group.lab", { cluster_name: "lab-saa-19-eks", node_group_name: "lab-saa-19-eks-ng", instance_types: ["t4g.medium"], scaling_config: [{ desired_size: 1, min_size: 1, max_size: 2 }], ...over }, { unknown: ["node_role_arn", "subnet_ids"], refs: { node_role_arn: ref("aws_iam_role.cluster", "arn"), subnet_ids: ["aws_subnet.private"] } });
  assert.deepEqual(rulesFor(c19, [crole, ng()], base), []);
  assert.deepEqual(rulesFor(c19, [crole, ng({ instance_types: ["m5.large"] })], base), ["size: aws_eks_node_group.lab"]);
  assert.deepEqual(rulesFor(c19, [crole, ng({ scaling_config: [{ desired_size: 1, min_size: 1, max_size: 3 }] })], base), ["size: aws_eks_node_group.lab"]);
});

test("lingering: an Athena workgroup without force_destroy, a stream without enforce_consumer_deletion, an ElastiCache final snapshot", () => {
  const wg = (force) => T(c17, "aws_athena_workgroup.wg", { name: "lab-saa-17-data-pipeline-wg", force_destroy: force, configuration: [{ enforce_workgroup_configuration: true, bytes_scanned_cutoff_per_query: 10485760, result_configuration: [{ output_location: "s3://cloudlabs-a17k3x9q-lake/athena/" }] }] });
  assert.deepEqual(rulesFor(c17, [wg(true)]), []);
  assert.deepEqual(rulesFor(c17, [wg(false)]), ["lingering: aws_athena_workgroup.wg"]);
  assert.deepEqual(rulesFor(c17, [T(c17, "aws_kinesis_stream.events", { name: "lab-saa-17-data-pipeline-events", shard_count: 1, retention_period: 24, enforce_consumer_deletion: false, stream_mode_details: [{ stream_mode: "PROVISIONED" }] })]), ["lingering: aws_kinesis_stream.events"]);
  assert.deepEqual(rulesFor(c11, [cacheGroup(c11), T(c11, "aws_elasticache_replication_group.app", { replication_group_id: "ca11k3x9q", description: "x", engine: "valkey", node_type: "cache.t4g.micro", num_cache_clusters: 1, subnet_group_name: "lab-saa-11-three-tier-data", final_snapshot_identifier: "keep-me" })]), ["lingering: aws_elasticache_replication_group.app"]);
});

test("ruling P5: a secondary provider needs a plan with secondary_region set", () => {
  const sec = { ...AWS_PROVIDER_CONFIG, "aws.secondary": { name: "aws", full_name: "registry.terraform.io/hashicorp/aws", alias: "secondary", expressions: { alias: { constant_value: "secondary" }, region: { references: ["var.secondary_region"] }, default_tags: [{ tags: { references: ["var.tags"] } }] } } };
  const p16 = (variables) => realisticPlan({ resources: templateMainResources(c16), data: awsData(), providers: ["aws"], providerConfig: sec, variables });
  assert.deepEqual(rules(p16(c16.variables), c16.id), []);
  assert.deepEqual(rules(p16({ ...c16.variables, secondary_region: "" }), c16.id), ["provider: provider.aws.secondary"]);
});

// ── Task 3 fix round 1 (task-3-review.md): each evil plan passed before its fix ──

const svcRoleFor = (cx, key, svc) => ({ address: `aws_iam_role.${key}`, values: tagged(cx, { name: `lab-${cx.id}-${key}`, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY, assume_role_policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: `${svc}.amazonaws.com` }, Action: "sts:AssumeRole" }] }) }), refs: {} });
/** A wholly unknown block: a dynamic block whose for_each is not known at plan (left out of the configuration). */
const dyn = (...blocks) => ({ unknown: blocks, dynamic: blocks });
const opaqueRef = (attr) => ({ unknown: [attr], refs: { [attr]: ref("aws_vpc.lab", "id") } });
const cacheGroup = (cx) => T(cx, "aws_elasticache_subnet_group.data", { name: `lab-${cx.id}-data`, description: "x" }, { unknown: ["subnet_ids"], refs: { subnet_ids: ["aws_subnet.private"] } });
const dbGroup = (cx) => T(cx, "aws_db_subnet_group.db", { name: `lab-${cx.id}-db` }, { unknown: ["subnet_ids"], refs: { subnet_ids: ["aws_subnet.private"] } });

test("fix round 1, I-1: a queue's own policy is read like any resource policy (ruling P10)", () => {
  const q = (Principal) => T(c13, "aws_sqs_queue.open", { name: "lab-saa-13-decoupling-open", policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal, Action: "sqs:SendMessage", Resource: "*" }] }) });
  assert.deepEqual(rulesFor(c13, [q("*")]), ["public: aws_sqs_queue.open"]);
  assert.deepEqual(rulesFor(c13, [q({ AWS: "arn:aws:iam::999999999999:root" })]), ["public: aws_sqs_queue.open"]);
  assert.deepEqual(rulesFor(c13, [q({ Service: "sns.amazonaws.com" })]), []);
  assert.deepEqual(rulesFor(c13, [T(c13, "aws_sqs_queue.plain", { name: "lab-saa-13-decoupling-plain" })]), [], "no policy written: the computed one is AWS's default");
});

test("fix round 1, I-2: a workflow reaches only the lab's own account and regions; no other SNS target, JSONata or credentials (ruling P14)", () => {
  const id = "saa-13-decoupling";
  const opts = { account: ACCOUNT, regions: ["eu-west-2"] };
  const task = (Resource, Parameters, extra = {}) => ({ StartAt: "A", States: { A: { Type: "Task", Resource, ...(Parameters ? { Parameters } : {}), End: true, ...extra } } });
  const fn = (acct, region = "eu-west-2") => `arn:aws:lambda:${region}:${acct}:function:lab-${id}-validate`;
  const topic = (acct, region = "eu-west-2") => `arn:aws:sns:${region}:${acct}:lab-${id}-orders`;
  const queue = (acct, region = "eu-west-2") => `https://sqs.${region}.amazonaws.com/${acct}/lab-${id}-billing`;
  const ok = [
    task(fn(ACCOUNT)),
    task("arn:aws:states:::lambda:invoke", { FunctionName: fn(ACCOUNT), "Payload.$": "$" }),
    task("arn:aws:states:::lambda:invoke", { FunctionName: `lab-${id}-validate` }),
    task("arn:aws:states:::sns:publish", { TopicArn: topic(ACCOUNT), "Message.$": "$" }),
    task("arn:aws:states:::sqs:sendMessage", { QueueUrl: queue(ACCOUNT), "MessageBody.$": "$" }),
  ];
  for (const d of ok) assert.equal(scope.workflowProblem(d, id, opts), null, JSON.stringify(d));
  const bad = [
    task(fn("999999999999")),
    task("arn:aws:states:::lambda:invoke", { FunctionName: fn("999999999999") }),
    task("arn:aws:states:::lambda:invoke", { FunctionName: fn(ACCOUNT, "us-east-1") }),
    task("arn:aws:states:::sns:publish", { TopicArn: topic("999999999999") }),
    task("arn:aws:states:::sqs:sendMessage", { QueueUrl: queue("999999999999") }),
    task("arn:aws:states:::sns:publish", { TargetArn: "arn:aws:sns:eu-west-2:999999999999:endpoint/APNS/x/y", Message: "hi" }),
    task("arn:aws:states:::sns:publish", { PhoneNumber: "+447700900000", Message: "hi" }),
    task("arn:aws:states:::sns:publish", { "TargetArn.$": "$.where", Message: "hi" }),
    task("arn:aws:states:::sns:publish", { "PhoneNumber.$": "$.who", Message: "hi" }),
    { QueryLanguage: "JSONata", StartAt: "A", States: { A: { Type: "Task", Resource: "arn:aws:states:::sns:publish", Arguments: "{% $states.input.args %}", End: true } } },
    { StartAt: "A", States: { A: { Type: "Task", Resource: "arn:aws:states:::sns:publish", Arguments: { TopicArn: "{% $states.input.topic %}" }, End: true } } },
    task("arn:aws:states:::lambda:invoke", { FunctionName: fn(ACCOUNT) }, { Credentials: { RoleArn: "arn:aws:iam::999999999999:role/x" } }),
  ];
  for (const d of bad) assert.notEqual(scope.workflowProblem(d, id, opts), null, JSON.stringify(d));
  // Through the plan: the lab's own account is the plan's caller identity, its region the session's.
  const sfnRole = svcRoleFor(c13, "sfn", "states");
  const sm = (acct) => T(c13, "aws_sfn_state_machine.orders", { name: `lab-${id}-orders`, type: "STANDARD", definition: JSON.stringify(task("arn:aws:states:::sns:publish", { TopicArn: topic(acct), "Message.$": "$" })) }, { unknown: ["role_arn"], refs: { role_arn: ref("aws_iam_role.sfn", "arn") } });
  assert.deepEqual(rulesFor(c13, [sfnRole, sm(ACCOUNT)]), []);
  assert.deepEqual(rulesFor(c13, [sfnRole, sm("999999999999")]), ["gateway: aws_sfn_state_machine.orders"]);
});

test("fix round 1, I-3: a block wholly unknown at plan (dynamic, for_each unknown) is refused where its elements are read", () => {
  const table = (more) => T(c16, "aws_dynamodb_table.orders", { name: "lab-saa-16-dr-pilot-light-orders", billing_mode: "PAY_PER_REQUEST", hash_key: "id", deletion_protection_enabled: false }, more);
  assert.deepEqual(rulesFor(c16, [table(dyn("replica"))]), ["provider: aws_dynamodb_table.orders"]);
  assert.deepEqual(rulesFor(c16, [T(c16, "aws_dynamodb_table.orders", { name: "lab-saa-16-dr-pilot-light-orders", billing_mode: "PAY_PER_REQUEST", hash_key: "id", global_table_witness: [{ region_name: "us-east-1" }] })]), ["provider: aws_dynamodb_table.orders"], "a witness is a third region");
  const zone = T(c16, "aws_route53_zone.z", { name: `${c16.prefix}.labs.clydeford.net`, force_destroy: true }, dyn("vpc"));
  assert.deepEqual(rulesFor(c16, [zone], templateResources(c16)), ["gateway: aws_route53_zone.z"]);
  const crole = svcRoleFor(c19, "nodes", "ec2");
  const ng = T(c19, "aws_eks_node_group.lab", { cluster_name: "lab-saa-19-eks", node_group_name: "lab-saa-19-eks-ng", instance_types: ["t4g.medium"], scaling_config: [{ desired_size: 1, min_size: 1, max_size: 2 }] }, { unknown: ["node_role_arn", "subnet_ids", "remote_access"], dynamic: ["remote_access"], refs: { node_role_arn: ref("aws_iam_role.nodes", "arn"), subnet_ids: ["aws_subnet.private"] } });
  assert.deepEqual(rulesFor(c19, [crole, ng], templateResources(c19)), ["public: aws_eks_node_group.lab"]);
  const crawlerRole = svcRoleFor(c17, "crawler", "glue");
  const crawler = T(c17, "aws_glue_crawler.events", { name: "lab-saa-17-data-pipeline-events", database_name: "lab_saa_17_data_pipeline", s3_target: [{ path: "s3://cloudlabs-a17k3x9q-lake/events/" }] }, { unknown: ["role", "jdbc_target"], dynamic: ["jdbc_target"], refs: { role: ref("aws_iam_role.crawler", "arn") } });
  assert.deepEqual(rulesFor(c17, [crawlerRole, crawler]), ["gateway: aws_glue_crawler.events"]);
  const clusterRole = svcRoleFor(c19, "cluster", "eks");
  const cluster = (blocks) => T(c19, "aws_eks_cluster.lab", { name: "lab-saa-19-eks", access_config: [{ authentication_mode: "API", bootstrap_cluster_creator_admin_permissions: false }], upgrade_policy: [{ support_type: "STANDARD" }], vpc_config: [{ endpoint_private_access: true, endpoint_public_access: true }] }, { unknown: ["role_arn", "vpc_config.0.subnet_ids", ...blocks], dynamic: blocks, refs: { role_arn: ref("aws_iam_role.cluster", "arn"), "vpc_config.0.subnet_ids": ["aws_subnet.private"] } });
  assert.deepEqual(rulesFor(c19, [clusterRole, cluster([])], templateResources(c19)), []);
  assert.deepEqual(rulesFor(c19, [clusterRole, cluster(["remote_network_config"])], templateResources(c19)), ["gateway: aws_eks_cluster.lab"]);
  assert.deepEqual(rulesFor(c19, [clusterRole, cluster(["compute_config"])], templateResources(c19)), ["size: aws_eks_cluster.lab"]);
});

test("fix round 1, I-4: a Firehose stream sends records only to the lab's own bucket: no backup, processor, conversion or other destination (ruling P14)", () => {
  const fhRole = svcRoleFor(c17, "firehose", "firehose");
  const stream = T(c17, "aws_kinesis_stream.events", { name: "lab-saa-17-data-pipeline-events", shard_count: 1, retention_period: 24, enforce_consumer_deletion: true, stream_mode_details: [{ stream_mode: "PROVISIONED" }] });
  const bucket = T(c17, "aws_s3_bucket.lake", { bucket: "cloudlabs-a17k3x9q-lake", force_destroy: true });
  const fh = (s3extra = {}, extra = {}) => T(c17, "aws_kinesis_firehose_delivery_stream.x", { name: "lab-saa-17-data-pipeline-to-s3", destination: "extended_s3", kinesis_source_configuration: [{}], extended_s3_configuration: [{ prefix: "events/", ...s3extra }], ...extra }, {
    unknown: ["kinesis_source_configuration.0.kinesis_stream_arn", "kinesis_source_configuration.0.role_arn", "extended_s3_configuration.0.bucket_arn", "extended_s3_configuration.0.role_arn"],
    refs: { "kinesis_source_configuration.0.kinesis_stream_arn": ref("aws_kinesis_stream.events", "arn"), "kinesis_source_configuration.0.role_arn": ref("aws_iam_role.firehose", "arn"), "extended_s3_configuration.0.bucket_arn": ref("aws_s3_bucket.lake", "arn"), "extended_s3_configuration.0.role_arn": ref("aws_iam_role.firehose", "arn") },
  });
  const base = [fhRole, stream, bucket];
  assert.deepEqual(rulesFor(c17, [...base, fh()]), []);
  assert.deepEqual(rulesFor(c17, [...base, fh({ s3_backup_mode: "Enabled", s3_backup_configuration: [{ bucket_arn: "arn:aws:s3:::someone-else", role_arn: `arn:aws:iam::${ACCOUNT}:role/x` }] })]), ["gateway: aws_kinesis_firehose_delivery_stream.x"]);
  assert.deepEqual(rulesFor(c17, [...base, fh({ processing_configuration: [{ enabled: true, processors: [{ type: "Lambda", parameters: [{ parameter_name: "LambdaArn", parameter_value: "arn:aws:lambda:eu-west-2:999999999999:function:x" }] }] }] })]), ["gateway: aws_kinesis_firehose_delivery_stream.x"]);
  assert.deepEqual(rulesFor(c17, [...base, fh({ data_format_conversion_configuration: [{ enabled: true, schema_configuration: [{ database_name: "x", table_name: "y", role_arn: `arn:aws:iam::${ACCOUNT}:role/x`, catalog_id: "999999999999" }] }] })]), ["gateway: aws_kinesis_firehose_delivery_stream.x"]);
  assert.deepEqual(rulesFor(c17, [...base, fh({}, { http_endpoint_configuration: [{ url: "https://example.com", s3_backup_mode: "FailedDataOnly" }] })]), ["gateway: aws_kinesis_firehose_delivery_stream.x"]);
});

test("fix round 1, I-5: a cache or database names the lab's own subnet group (never unset or default: the default VPC)", () => {
  const rg = (over = {}) => T(c11, "aws_elasticache_replication_group.app", { replication_group_id: "ca11k3x9q", description: "x", engine: "valkey", node_type: "cache.t4g.micro", num_cache_clusters: 1, ...over });
  const base = templateResources(c11);
  assert.deepEqual(rulesFor(c11, [cacheGroup(c11), rg({ subnet_group_name: "lab-saa-11-three-tier-data" })], base), []);
  assert.deepEqual(rulesFor(c11, [cacheGroup(c11), rg({}, )], base), ["gateway: aws_elasticache_replication_group.app"], "unset: the default subnet group");
  assert.deepEqual(rulesFor(c11, [cacheGroup(c11), rg({ subnet_group_name: "default" })], base), ["gateway: aws_elasticache_replication_group.app"]);
  assert.deepEqual(rulesFor(c11, [cacheGroup(c11), { ...rg(), unknown: ["subnet_group_name"], refs: { subnet_group_name: ref("aws_elasticache_subnet_group.data", "name") } }], base), [], "by reference");
  const { db_subnet_group_name: _group, ...noGroup } = DB;
  const db = (over = {}) => T(c11, "aws_db_instance.app", { ...noGroup, ...over });
  assert.deepEqual(rulesFor(c11, [dbGroup(c11), db({ db_subnet_group_name: "lab-saa-11-three-tier-db" })], base), []);
  assert.deepEqual(rulesFor(c11, [dbGroup(c11), db()], base), ["gateway: aws_db_instance.app"], "unset: the default VPC");
  assert.deepEqual(rulesFor(c11, [dbGroup(c11), db({ db_subnet_group_name: "default" })], base), ["gateway: aws_db_instance.app"]);
  // A replica in the same region takes its source's subnet group; its source is the lab's own database.
  const replica = (src) => T(c11, "aws_db_instance.replica", { ...noGroup, identifier: "db-a11k3x9q-replica", replicate_source_db: src });
  assert.deepEqual(rulesFor(c11, [dbGroup(c11), db({ db_subnet_group_name: "lab-saa-11-three-tier-db" }), replica("db-a11k3x9q")], base), []);
  assert.deepEqual(rulesFor(c11, [dbGroup(c11), db({ db_subnet_group_name: "lab-saa-11-three-tier-db" }), replica("someone-elses-db")], base), ["gateway: aws_db_instance.replica"]);
});

test("fix round 1, I-6 and M-2, M-3: a value rule refuses a value built from references that is not known at plan", () => {
  const base11 = templateResources(c11);
  const cases = [
    [c11, T(c11, "aws_db_instance.app", { ...DB, db_subnet_group_name: "lab-saa-11-three-tier-db" }, opaqueRef("publicly_accessible")), "public", [dbGroup(c11)], base11],
    [c11, T(c11, "aws_elasticache_replication_group.app", { replication_group_id: "ca11k3x9q", description: "x", engine: "valkey", node_type: "cache.t4g.micro", num_cache_clusters: 1, subnet_group_name: "lab-saa-11-three-tier-data" }, opaqueRef("final_snapshot_identifier")), "lingering", [cacheGroup(c11)], base11],
    [c11, T(c11, "aws_elasticache_replication_group.app", { replication_group_id: "ca11k3x9q", description: "x", engine: "valkey", node_type: "cache.t4g.micro", subnet_group_name: "lab-saa-11-three-tier-data" }, opaqueRef("num_cache_clusters")), "size", [cacheGroup(c11)], base11],
    [c11, T(c11, "aws_elasticache_replication_group.app", { replication_group_id: "ca11k3x9q", description: "x", engine: "valkey", node_type: "cache.t4g.micro", num_cache_clusters: 1, subnet_group_name: "lab-saa-11-three-tier-data" }, opaqueRef("num_node_groups")), "size", [cacheGroup(c11)], base11],
    [c12, T(c12, "aws_cognito_user_pool.users", { name: "lab-saa-12-serverless-api-users", user_pool_tier: "LITE" }, opaqueRef("deletion_protection")), "lingering"],
    [c12, T(c12, "aws_cognito_user_pool.users", { name: "lab-saa-12-serverless-api-users", deletion_protection: "INACTIVE" }, opaqueRef("user_pool_tier")), "size"],
    [c17, T(c17, "aws_glue_crawler.events", { name: "lab-saa-17-data-pipeline-events", database_name: "lab_saa_17_data_pipeline", s3_target: [{ path: "s3://cloudlabs-a17k3x9q-lake/events/" }] }, { unknown: ["role", "schedule"], refs: { role: ref("aws_iam_role.crawler", "arn"), schedule: ref("aws_vpc.lab", "id") } }), "size", [svcRoleFor(c17, "crawler", "glue")]],
    [c11, T(c11, "aws_efs_file_system.shared", { encrypted: true }, opaqueRef("throughput_mode")), "size", [], base11],
    [c16, T(c16, "aws_route53_zone.dr", { force_destroy: true, vpc: [{ vpc_region: "eu-west-2" }] }, { unknown: ["vpc.0.vpc_id", "name"], refs: { "vpc.0.vpc_id": ref("aws_vpc.lab", "id"), name: ref("aws_vpc.lab", "id") } }), "gateway", [], templateResources(c16)],
    [c12, U("aws_apigatewayv2_authorizer.a", { name: "cognito", identity_sources: ["$request.header.Authorization"] }, { unknown: ["api_id", "authorizer_type"], refs: { api_id: ref("aws_apigatewayv2_api.lab", "id"), authorizer_type: ref("aws_vpc.lab", "id") } }), "gateway", [T(c12, "aws_apigatewayv2_api.lab", { name: "lab-saa-12-serverless-api", protocol_type: "HTTP" })], templateResources(c12)],
  ];
  for (const [cx, r, rule, extra = [], base] of cases) assert.deepEqual(rulesFor(cx, [...extra, r], base), [`${rule}: ${r.address}`], `${r.address} ${JSON.stringify(r.unknown)}`);
  // Firehose error logging built from references.
  const fh = T(c17, "aws_kinesis_firehose_delivery_stream.x", { name: "lab-saa-17-data-pipeline-to-s3", destination: "extended_s3", kinesis_source_configuration: [{}], extended_s3_configuration: [{ cloudwatch_logging_options: [{}] }] }, {
    unknown: ["kinesis_source_configuration.0.kinesis_stream_arn", "kinesis_source_configuration.0.role_arn", "extended_s3_configuration.0.bucket_arn", "extended_s3_configuration.0.role_arn", "extended_s3_configuration.0.cloudwatch_logging_options.0.enabled"],
    refs: { "kinesis_source_configuration.0.kinesis_stream_arn": ref("aws_kinesis_stream.events", "arn"), "kinesis_source_configuration.0.role_arn": ref("aws_iam_role.firehose", "arn"), "extended_s3_configuration.0.bucket_arn": ref("aws_s3_bucket.lake", "arn"), "extended_s3_configuration.0.role_arn": ref("aws_iam_role.firehose", "arn"), "extended_s3_configuration.0.cloudwatch_logging_options.0.enabled": ref("aws_vpc.lab", "id") },
  });
  const fbase = [svcRoleFor(c17, "firehose", "firehose"), T(c17, "aws_kinesis_stream.events", { name: "lab-saa-17-data-pipeline-events", shard_count: 1, retention_period: 24, enforce_consumer_deletion: true }), T(c17, "aws_s3_bucket.lake", { bucket: "cloudlabs-a17k3x9q-lake", force_destroy: true })];
  assert.deepEqual(rulesFor(c17, [...fbase, fh], templateResources(c17)), ["lingering: aws_kinesis_firehose_delivery_stream.x"]);
  // M-2: one route's own throttle above the cap.
  const api = T(c12, "aws_apigatewayv2_api.lab", { name: "lab-saa-12-serverless-api", protocol_type: "HTTP" });
  const stage = (route) => T(c12, "aws_apigatewayv2_stage.default", { name: "$default", auto_deploy: true, default_route_settings: [{ throttling_burst_limit: 10, throttling_rate_limit: 5 }], route_settings: [{ route_key: "GET /items", ...route }] }, { unknown: ["api_id"], refs: { api_id: ref("aws_apigatewayv2_api.lab", "id") } });
  assert.deepEqual(rulesFor(c12, [api, stage({ throttling_burst_limit: 5, throttling_rate_limit: 2 })]), []);
  assert.deepEqual(rulesFor(c12, [api, stage({ throttling_burst_limit: 5000, throttling_rate_limit: 10000 })]), ["size: aws_apigatewayv2_stage.default"]);
});

test("fix round 1, M-1, M-4, M-5: an AMI copy only of the parameter's AMI; roles API Gateway passes; no outside data brought in", () => {
  // M-1: a known source equal to a string some other data source read is not the parameter's AMI.
  const other = { address: "data.aws_region.current", values: { name: "ami-0fedcba9876543210" }, refs: {} };
  const p16 = (extra) => rules(realisticPlan({ resources: [...templateResources(c16), ...extra], data: [...awsData(), other], providers: ["aws"], providerConfig: AWS_PROVIDER_CONFIG, variables: c16.variables }), c16.id);
  const copy = (src, more = {}) => T(c16, "aws_ami_copy.dr", { name: "lab-saa-16-dr-pilot-light-al2023", source_ami_region: "eu-west-2", ...(src ? { source_ami_id: src } : {}) }, more);
  assert.deepEqual(p16([copy(AMI)]), []);
  assert.deepEqual(p16([copy("ami-0fedcba9876543210")]), ["gateway: aws_ami_copy.dr"]);
  assert.deepEqual(p16([copy(null, { unknown: ["source_ami_id"], refs: { source_ami_id: ["data.aws_ssm_parameter.al2023_arm64.insecure_value", "data.aws_ssm_parameter.al2023_arm64", "aws_vpc.lab.id", "aws_vpc.lab"] } })]), ["gateway: aws_ami_copy.dr"], "the parameter mixed with something else");
  // M-4: an integration or authoriser passing a role that is not the lab's own.
  const api = T(c12, "aws_apigatewayv2_api.lab", { name: "lab-saa-12-serverless-api", protocol_type: "HTTP" });
  const fnRole = svcRoleFor(c12, "fn", "lambda");
  const fn = T(c12, "aws_lambda_function.api", { function_name: "lab-saa-12-serverless-api-api", memory_size: 128, timeout: 10 }, { unknown: ["role"], refs: { role: ref("aws_iam_role.fn", "arn") } });
  const integ = (over) => U("aws_apigatewayv2_integration.x", { integration_type: "AWS_PROXY", payload_format_version: "2.0", ...over }, { unknown: ["api_id", "integration_uri"], refs: { api_id: ref("aws_apigatewayv2_api.lab", "id"), integration_uri: ref("aws_lambda_function.api", "invoke_arn") } });
  const only = (rs, a) => rs.filter((x) => x.endsWith(a));
  assert.deepEqual(only(rulesFor(c12, [api, fnRole, fn, integ({})]), "integration.x"), []);
  assert.deepEqual(only(rulesFor(c12, [api, fnRole, fn, integ({ credentials_arn: `arn:aws:iam::${ACCOUNT}:role/wg-admin-labs` })]), "integration.x"), ["iam: aws_apigatewayv2_integration.x"]);
  // M-5: a table restored or imported from outside the lab, a cache seeded from a snapshot, a Glue database linked elsewhere.
  const table = (extra) => T(c16, "aws_dynamodb_table.orders", { name: "lab-saa-16-dr-pilot-light-orders", billing_mode: "PAY_PER_REQUEST", hash_key: "id", ...extra });
  assert.deepEqual(rulesFor(c16, [table({ restore_source_table_arn: "arn:aws:dynamodb:eu-west-2:999999999999:table/theirs" })]), ["gateway: aws_dynamodb_table.orders"]);
  assert.deepEqual(rulesFor(c16, [table({ import_table: [{ input_format: "CSV", s3_bucket_source: [{ bucket: "someone-else" }] }] })]), ["gateway: aws_dynamodb_table.orders"]);
  assert.deepEqual(rulesFor(c11, [cacheGroup(c11), T(c11, "aws_elasticache_replication_group.app", { replication_group_id: "ca11k3x9q", description: "x", engine: "valkey", node_type: "cache.t4g.micro", num_cache_clusters: 1, subnet_group_name: "lab-saa-11-three-tier-data", snapshot_arns: ["arn:aws:s3:::someone-else/dump.rdb"] })], templateResources(c11)), ["gateway: aws_elasticache_replication_group.app"]);
  assert.deepEqual(rulesFor(c17, [T(c17, "aws_glue_catalog_database.lake", { name: "lab_saa_17_data_pipeline", target_database: [{ catalog_id: "999999999999", database_name: "theirs" }] })]), ["gateway: aws_glue_catalog_database.lake"]);
});

test("fix round 1, M-6: P9's run-command target check still reports first on an EventBridge target (plan mode), ahead of P14", () => {
  const target = (targets) => plan([role(), { address: "aws_cloudwatch_event_target.run", values: { arn: "arn:aws:ssm:eu-west-2::document/AWS-RunShellScript", run_command_targets: targets }, unknown: ["rule", "role_arn"], refs: { role_arn: ref("aws_iam_role.vm", "arn") } }]);
  const msg = (targets) => scope.checkPlanAws(target(targets), ID).find((p) => p.address === "aws_cloudwatch_event_target.run")?.message ?? "";
  assert.match(msg([{ key: "tag:managed", values: ["terraform"] }]), /ruling P9/);
  assert.match(msg([{ key: "InstanceIds", values: ["*"] }]), /every instance/);
  assert.match(msg([{ key: "InstanceIds", values: ["i-0123456789abcdef0"] }]), /names an existing AWS resource/);
  assert.match(msg([{ key: "tag:Name", values: ["vm-wg"] }]), /VPN server/);
});
