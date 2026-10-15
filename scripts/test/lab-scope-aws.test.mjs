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
import { AWS_CONFIG_LABS, AWS_GLOBAL_LABS, AWS_IAM_USER_LABS, AWS_INSTANCE_TYPES, AWS_MEDIUM_LABS, LAB_ID_RE } from "../lib/labs.mjs";
import * as scope from "../../infra/ci/lab-scope-aws.mjs";
import { planResources } from "../../infra/ci/lab-scope.mjs";
import { realisticPlan } from "./fixtures/labs/plans/realistic.mjs";
import { ACCOUNT, al2023Instance, AMI, AWS_PROVIDER_CONFIG, awsData, BOUNDARY, ctxAws, ref, tagged, templateResources } from "./fixtures/labs/plans/common-aws.mjs";

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
  for (const [a, b] of [[scope.AWS_CONFIG_LABS, AWS_CONFIG_LABS], [scope.AWS_GLOBAL_LABS, AWS_GLOBAL_LABS], [scope.AWS_IAM_USER_LABS, AWS_IAM_USER_LABS], [scope.AWS_INSTANCE_TYPES, AWS_INSTANCE_TYPES], [scope.AWS_MEDIUM_LABS, AWS_MEDIUM_LABS]]) assert.deepEqual([...a], [...b]);
});

const role = (over = {}) => ({
  address: "aws_iam_role.vm",
  values: tagged(c, { name: `lab-${ID}-vm`, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY, assume_role_policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }] }), ...over }),
  refs: {},
});
const trustAws = (principal) => JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { AWS: principal }, Action: "sts:AssumeRole" }] });
const policy = (doc) => ({ address: "aws_iam_policy.extra", values: tagged(c, { name: `lab-${ID}-extra`, path: "/cloudlabs-lab/", policy: JSON.stringify(doc) }), refs: {} });

// [rule, what, a change to the clean plan]
const EVIL = [
  ["provider", "an aws provider with a profile", () => plan([], { providerConfig: { aws: { ...AWS_PROVIDER_CONFIG.aws, expressions: { ...AWS_PROVIDER_CONFIG.aws.expressions, profile: { constant_value: "admin" } } } } })],
  ["provider", "an aws provider in us-east-1 outside the global labs", () => plan([], { providerConfig: { aws: { ...AWS_PROVIDER_CONFIG.aws, expressions: { ...AWS_PROVIDER_CONFIG.aws.expressions, region: { constant_value: "us-east-1" } } } } })],
  ["provider", "a null provider resource", () => plan([{ address: "null_resource.x", values: {}, refs: {} }])],
  ["provider", "a resource in another region (aws provider 6's own region)", () => plan([{ address: "aws_sns_topic.far", values: tagged(c, { name: "far", region: "us-east-1" }), refs: {} }])],
  ["provisioner", "a provisioner", () => { const p = plan(); p.configuration.root_module.resources.find((r) => r.address === "aws_vpc.lab").provisioners = [{ type: "local-exec" }]; return p; }],
  ["import", "adopting an existing VPC", () => plan([{ ...templateResources(c)[1], address: "aws_vpc.adopted", importing: { id: "vpc-0123456789abcdef0" } }])],
  ["type", "a type not on the allow-list", () => plan([{ address: "aws_lambda_function.x", values: tagged(c, { function_name: "x" }), refs: {} }])],
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
  ["gateway", "a peering accepter", () => plan([{ address: "aws_vpc_peering_connection_accepter.x", values: tagged(c, { auto_accept: true }), unknown: ["vpc_peering_connection_id"], refs: {} }])],
  ["gateway", "a tag key wg-admin", () => plan([{ address: "aws_sns_topic.x", values: { name: "x", tags: { "wg-admin": "vpn" }, tags_all: { ...c.tags, "wg-admin": "vpn" } }, refs: {} }])],
  ["gateway", "an alarm on an existing instance (dimensions InstanceId, review round 1)", () => plan([{ address: "aws_cloudwatch_metric_alarm.cpu", values: tagged(c, { alarm_name: "cpu", comparison_operator: "GreaterThanThreshold", evaluation_periods: 1, metric_name: "CPUUtilization", namespace: "AWS/EC2", period: 300, statistic: "Average", threshold: 80, dimensions: { InstanceId: "i-0123456789abcdef0" } }), refs: {} }])],
  ["gateway", "an SSM association targeting existing instances by id", () => plan([{ address: "aws_ssm_association.patch", values: tagged(c, { name: "AWS-RunPatchBaseline", targets: [{ key: "InstanceIds", values: ["i-0123456789abcdef0"] }] }), refs: {} }])],
  ["gateway", "an EventBridge target running a command on existing instances", () => plan([{ address: "aws_cloudwatch_event_target.run", values: { arn: "arn:aws:ssm:eu-west-2::document/AWS-RunShellScript", run_command_targets: [{ key: "InstanceIds", values: ["i-0123456789abcdef0"] }] }, unknown: ["rule", "role_arn"], refs: {} }])],
  // Final review, Important 3: the VPN server's other names, and instance targets that select every instance.
  ...["vm-wg", "nic-wg", "pip-wg", "osdisk-wg", "sg-workloads", "vm-test", "osdisk-test"].map((n) => ["gateway", `an SSM association targeting tag:Name = ${n}`, () => plan([{ address: "aws_ssm_association.x", values: tagged(c, { name: "AWS-RunShellScript", targets: [{ key: "tag:Name", values: [n] }] }), refs: {} }])]),
  ["gateway", "an SSM association targeting InstanceIds = *", () => plan([{ address: "aws_ssm_association.all", values: tagged(c, { name: "AWS-RunShellScript", targets: [{ key: "InstanceIds", values: ["*"] }] }), refs: {} }])],
  ["gateway", "an SSM association on instance_id = *", () => plan([{ address: "aws_ssm_association.all", values: tagged(c, { name: "AWS-RunShellScript", instance_id: "*" }), refs: {} }])],
  ["gateway", "an SSM association targeting every instance with a Name tag (tag-key)", () => plan([{ address: "aws_ssm_association.all", values: tagged(c, { name: "AWS-RunShellScript", targets: [{ key: "tag-key", values: ["Name"] }] }), refs: {} }])],
  ["gateway", "an SSM association targeting a wildcard tag value", () => plan([{ address: "aws_ssm_association.all", values: tagged(c, { name: "AWS-RunShellScript", targets: [{ key: "tag:Name", values: ["vm-*"] }] }), refs: {} }])],
  ["gateway", "an EventBridge target running a command on InstanceIds *", () => plan([{ address: "aws_cloudwatch_event_target.run", values: { arn: "arn:aws:ssm:eu-west-2::document/AWS-RunShellScript", run_command_targets: [{ key: "InstanceIds", values: ["*"] }] }, unknown: ["rule", "role_arn"], refs: {} }])],
  ["gateway", "an EventBridge target running a command on vm-wg by name", () => plan([{ address: "aws_cloudwatch_event_target.run", values: { arn: "arn:aws:ssm:eu-west-2::document/AWS-RunShellScript", run_command_targets: [{ key: "tag:Name", values: ["vm-wg"] }] }, unknown: ["rule", "role_arn"], refs: {} }])],
  ["gateway", "a backup selection naming an existing instance by ARN", () => plan([{ address: "aws_backup_selection.vms", values: { name: "vms", resources: ["arn:aws:ec2:eu-west-2:123456789012:instance/i-0123456789abcdef0"] }, unknown: ["plan_id", "iam_role_arn"], refs: {} }])],
  ["address", "a VPC outside the slot", () => { const base = templateResources(c); base[1] = { ...base[1], values: { ...base[1].values, cidr_block: "10.65.0.0/20" } }; return plan([], { base }); }],
  ["address", "a route to another lab's slot", () => plan([{ address: "aws_route.other", values: { destination_cidr_block: "10.66.0.0/18" }, unknown: ["route_table_id", "vpc_peering_connection_id"], refs: { route_table_id: ref("aws_route_table.private", "id") } }])],
  ["public", "an instance with a public IP", () => { const i = al2023Instance(c, { key: "app", name: "vm-app" }); i.values.associate_public_ip_address = true; return plan([i]); }],
  ["public", "a subnet that maps public IPs", () => { const base = templateResources(c); base[2] = { ...base[2], values: { ...base[2].values, map_public_ip_on_launch: true } }; return plan([], { base }); }],
  ["public", "SSH from the internet", () => plan([{ address: "aws_vpc_security_group_ingress_rule.ssh_world", values: tagged(c, { cidr_ipv4: "0.0.0.0/0", ip_protocol: "tcp", from_port: 22, to_port: 22 }), unknown: ["security_group_id"], refs: { security_group_id: ref("aws_security_group.vms", "id") } }])],
  ["lingering", "a database that keeps a final snapshot", () => plan([{ address: "aws_db_instance.db", values: tagged(c, { instance_class: "db.t4g.micro", allocated_storage: 20, skip_final_snapshot: false, deletion_protection: false, delete_automated_backups: true, copy_tags_to_snapshot: true }), unknown: ["db_subnet_group_name"], refs: {} }])],
  ["lingering", "a bucket that cannot be force-destroyed", () => plan([{ address: "aws_s3_bucket.b", values: tagged(c, { bucket: `cloudlabs-${c.prefix}-x`, force_destroy: false }), refs: {} }])],
  ["lingering", "a log group kept for 30 days", () => plan([{ address: "aws_cloudwatch_log_group.g", values: tagged(c, { name: "/cloudlabs/x", retention_in_days: 30, skip_destroy: false }), refs: {} }])],
  ["lingering", "a load balancer with deletion protection", () => plan([{ address: "aws_lb.web", values: tagged(c, { name: "alb-x", internal: false, load_balancer_type: "application", enable_deletion_protection: true }), unknown: ["subnets", "security_groups"], refs: {} }])],
  ["size", "an m5.large instance", () => plan([al2023Instance(c, { key: "big", name: "vm-big", type: "m5.large" })])],
  ["size", "a 100 GiB volume", () => plan([{ address: "aws_ebs_volume.big", values: tagged(c, { availability_zone: "eu-west-2a", size: 100, type: "gp3" }), refs: {} }])],
  ["size", "an Auto Scaling group of 10", () => plan([{ address: "aws_autoscaling_group.g", values: { min_size: 2, max_size: 10, desired_capacity: 2, tag: [{ key: "cloudlabs-lab", value: ID, propagate_at_launch: true }] }, unknown: ["vpc_zone_identifier"], refs: {} }])],
  ["description", "a security group description with an apostrophe", () => plan([{ address: "aws_security_group.apos", values: tagged(c, { name: "lab-apos", description: "SSH out to the lab's instances" }), unknown: ["vpc_id"], refs: {} }])],
  ["description", "a security group description of 256 characters", () => plan([{ address: "aws_security_group.long", values: tagged(c, { name: "lab-long", description: "a".repeat(256) }), unknown: ["vpc_id"], refs: {} }])],
  ["description", "an ingress block description with a quote", () => plan([{ address: "aws_security_group.blk", values: tagged(c, { name: "lab-blk", description: "ok", ingress: [{ description: 'say "hi"', protocol: "tcp", from_port: 80, to_port: 80, cidr_blocks: ["10.0.0.0/8"] }] }), unknown: ["vpc_id"], refs: {} }])],
  ["description", "a VPC security group rule description with a backtick", () => plan([{ address: "aws_vpc_security_group_egress_rule.r", values: tagged(c, { description: "all `out`", ip_protocol: "-1", cidr_ipv4: "10.0.0.0/8" }), unknown: ["security_group_id"], refs: {} }])],
];
for (const [rule, what, make] of EVIL) {
  test(`${rule}: refuses ${what}`, () => {
    const got = scope.checkPlanAws(make(), ID);
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
    { address: "aws_cloudwatch_event_target.run", values: { arn: "arn:aws:ssm:eu-west-2::document/AWS-RunShellScript", run_command_targets: [{ key: "InstanceIds" }] }, unknown: ["rule", "role_arn", "run_command_targets.0.values"], refs: { "run_command_targets.0.values": own } },
    { address: "aws_backup_selection.vms", values: { name: "vms", resources: [] }, unknown: ["plan_id", "iam_role_arn", "resources.0"], refs: { resources: ref("aws_instance.web", "arn") } },
    { address: "aws_backup_selection.tagged", values: { name: "tagged", selection_tag: [{ type: "STRINGEQUALS", key: "cloudlabs-lab", value: ID }] }, unknown: ["plan_id", "iam_role_arn"], refs: { "selection_tag.0.value": ["var.lab_id"] } },
  ];
  assert.deepEqual(rules(plan(extra)), []);
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
  const user7 = { ...user, values: tagged(c7, { name: "lab-soa-07-iam-kms-u", path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY }) };
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
