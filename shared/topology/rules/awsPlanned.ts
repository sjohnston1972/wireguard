// shared/topology/rules/awsPlanned.ts
//
// Plain English: what each AWS Terraform type becomes on a planned diagram
// (AWS labs spec §10, plan ruling P5, preflight C9). The same TfRule shape as
// the Azure rules (rules/planned.ts), merged into TF_RULES there; the AWS
// builder (awsPlannedGraph.ts) runs them. `arm` of every rule is the type the
// Resource Groups Tagging API gives the live resource ("ec2:vpc"), so a
// planned key and a live key agree: "<that type>/<Name tag, else name>".
//
// A type with no tagging-API type folds into a tagged card instead of being a
// card of its own (a dashboard and a query definition into the lab's log
// group, the Config pieces into the Config rule, a patch group into its
// baseline), so no planned card has a key the live view cannot list.
//
// Attribute names are Terraform's (aws 6.x). `refs` are the HCL references of
// a top-level attribute; values come from the mock plan, where computed ids
// are unknown.

import type { PlannedHelpers, TfInst, TfRule } from "./planned";

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The Name tag of an instance: a `tags` map, or an Auto Scaling group's `tag` blocks. */
function nameTag(after: Record<string, unknown>): string | undefined {
  const t = str(obj(after.tags).Name);
  if (t) return t;
  for (const b of list(after.tag)) if (str(obj(b).key) === "Name") return str(obj(b).value);
  return undefined;
}

/** The name an AWS resource is shown and keyed by: its Name tag, else its own name, else the Terraform address's name. */
export function awsNameOf(i: TfInst): string {
  const a = i.after;
  return nameTag(a) ?? str(a.name) ?? str(a.bucket) ?? str(a.identifier) ?? str(a.alarm_name) ?? str(a.function_name) ?? str(a.rule_name) ?? str(a.dashboard_name) ?? str(a.analyzer_name) ?? str(a.family) ?? (i.index !== null ? `${i.name}[${i.index}]` : i.name);
}

/** A rule folding into the instance an attribute references. */
const into = (...attrs: string[]): TfRule => ({ fold: attrs });
/** A rule folding into the first instance of these types that references it. */
const intoReferrer = (...types: string[]): TfRule => ({ foldToReferrer: { types } });
/** Same rule for several Terraform types. */
const each = (types: string[], rule: TfRule): Record<string, TfRule> => Object.fromEntries(types.map((t) => [t, rule]));

const firstOfType = (type: string) => (_i: TfInst, h: PlannedHelpers): TfInst | null => h.byType(type)[0] ?? null;

/** The service's last dot-part: com.amazonaws.eu-west-2.ssm → ssm. */
const lastPart = (s: string | undefined): string | undefined => s?.split(".").at(-1);

/** The targets behind a listener's target groups: Auto Scaling groups, ECS services and instances. */
function behind(tg: TfInst, h: PlannedHelpers): TfInst[] {
  const out: TfInst[] = [...h.referrers(tg, ["aws_autoscaling_group", "aws_ecs_service"])];
  for (const att of h.referrers(tg, ["aws_lb_target_group_attachment"])) for (const t of h.refs(att, ["target_id"])) if (t.type === "aws_instance" && !out.includes(t)) out.push(t);
  return out;
}

const S3_PIECES = [
  "aws_s3_bucket_versioning",
  "aws_s3_bucket_lifecycle_configuration",
  "aws_s3_bucket_public_access_block",
  "aws_s3_bucket_policy",
  "aws_s3_bucket_server_side_encryption_configuration",
  "aws_s3_bucket_ownership_controls",
  "aws_s3_bucket_acl",
  "aws_s3_bucket_logging",
  "aws_s3_bucket_notification",
  "aws_s3_bucket_cors_configuration",
  "aws_s3_bucket_website_configuration",
  "aws_s3_bucket_accelerate_configuration",
  "aws_s3_bucket_intelligent_tiering_configuration",
  "aws_s3_object",
];

export const AWS_TF_RULES: Record<string, TfRule> = {
  // Not AWS resources: helpers a lab may use beside the aws provider.
  ...each(["tls_private_key", "tls_self_signed_cert", "tls_cert_request", "archive_file", "random_password"], { ignore: true }),

  // ── Groups ──
  aws_resourcegroups_group: { arm: "resource-groups:group" },
  aws_vpc: { arm: "ec2:vpc", props: (i) => ({ addressSpace: str(i.after.cidr_block) ? [str(i.after.cidr_block)!] : undefined }) },
  aws_subnet: { arm: "ec2:subnet", props: (i) => ({ prefix: str(i.after.cidr_block) }) },

  // ── Compute ──
  aws_instance: { arm: "ec2:instance", props: (i) => ({ size: str(i.after.instance_type), privateIp: str(i.after.private_ip) }) },
  aws_launch_template: { arm: "ec2:launch-template", ...intoReferrer("aws_autoscaling_group") },
  aws_autoscaling_group: {
    arm: "autoscaling:autoScalingGroup",
    props: (i, h) => ({ size: str(h.refs(i, ["launch_template"])[0]?.after.instance_type), instances: num(i.after.desired_capacity) }),
  },
  ...each(["aws_autoscaling_policy", "aws_autoscaling_schedule", "aws_autoscaling_lifecycle_hook", "aws_autoscaling_attachment", "aws_autoscaling_notification"], into("autoscaling_group_name")),
  aws_ebs_volume: { arm: "ec2:volume", ...intoReferrer("aws_volume_attachment") },
  aws_volume_attachment: { fold: ["instance_id"], pull: ["volume_id"] },
  aws_ebs_snapshot: into("volume_id"),

  // ── Load balancing: target groups, listeners and rules fold in; the traffic edge goes to what the target groups reach ──
  aws_lb: {
    arm: "elasticloadbalancing:loadbalancer",
    props: (i) => ({ sku: str(i.after.load_balancer_type) ?? "application" }),
    edges: (i, h) => {
      const out: { from: TfInst; to: TfInst; kind: "traffic"; label?: string }[] = [];
      for (const l of h.referrers(i, ["aws_lb_listener"], ["load_balancer_arn"])) {
        const port = num(l.after.port) ?? str(l.after.port);
        const label = port !== undefined ? `${str(l.after.protocol) ?? "HTTP"} ${port}` : undefined;
        const groups = [...h.refs(l, ["default_action"]), ...h.referrers(l, ["aws_lb_listener_rule"], ["listener_arn"]).flatMap((r) => h.refs(r, ["action"]))].filter((t) => t.type === "aws_lb_target_group");
        for (const tg of groups) for (const t of behind(tg, h)) if (!out.some((e) => e.to === t && e.label === label)) out.push({ from: i, to: t, kind: "traffic", ...(label ? { label } : {}) });
      }
      return out;
    },
  },
  aws_alb: { arm: "elasticloadbalancing:loadbalancer" },
  aws_lb_listener: into("load_balancer_arn"),
  aws_lb_listener_rule: into("listener_arn"),
  aws_lb_target_group: { ...intoReferrer("aws_lb_listener"), arm: "elasticloadbalancing:targetgroup" },
  aws_lb_target_group_attachment: into("target_group_arn"),

  // ── Network ──
  aws_security_group: { arm: "ec2:security-group" },
  ...each(["aws_vpc_security_group_ingress_rule", "aws_vpc_security_group_egress_rule", "aws_security_group_rule"], into("security_group_id")),
  aws_route_table: { arm: "ec2:route-table" },
  ...each(["aws_route_table_association", "aws_main_route_table_association"], into("route_table_id")),
  aws_route: {
    fold: ["route_table_id"],
    edges: (i, h) => {
      const rt = h.refs(i, ["route_table_id"])[0];
      if (!rt) return [];
      return h
        .refs(i, ["gateway_id", "nat_gateway_id"])
        .filter((t) => t.type === "aws_internet_gateway" || t.type === "aws_nat_gateway")
        .map((t) => ({ from: rt, to: t, kind: "dependency" as const, ...(str(i.after.destination_cidr_block) ? { label: str(i.after.destination_cidr_block)! } : {}) }));
    },
  },
  aws_internet_gateway: { arm: "ec2:internet-gateway" },
  aws_nat_gateway: { arm: "ec2:natgateway" },
  aws_eip: { arm: "ec2:elastic-ip", ...intoReferrer("aws_nat_gateway", "aws_eip_association", "aws_instance") },
  aws_eip_association: { fold: ["instance_id", "network_interface_id"], pull: ["allocation_id"] },
  aws_vpc_endpoint: { arm: "ec2:vpc-endpoint", props: (i) => ({ groupId: lastPart(str(i.after.service_name)) }) },
  aws_ec2_instance_connect_endpoint: { arm: "ec2:instance-connect-endpoint" },
  aws_vpc_peering_connection: {
    fold: ["vpc_id"],
    edges: (i, h) => {
      const a = h.refs(i, ["vpc_id"])[0];
      const b = h.refs(i, ["peer_vpc_id"])[0];
      return a && b ? [{ from: a, to: b, kind: "traffic" as const, label: "peering", undirected: true }] : [];
    },
  },
  aws_ec2_transit_gateway: { arm: "ec2:transit-gateway" },
  aws_ec2_transit_gateway_vpc_attachment: {
    fold: ["transit_gateway_id"],
    edges: (i, h) => {
      const tgw = h.refs(i, ["transit_gateway_id"])[0];
      const vpc = h.refs(i, ["vpc_id"])[0];
      return tgw && vpc ? [{ from: tgw, to: vpc, kind: "traffic" as const, label: "attachment" }] : [];
    },
  },

  // ── Data ──
  aws_db_instance: {
    arm: "rds:db",
    props: (i) => ({ publicAccess: typeof i.after.publicly_accessible === "boolean" ? i.after.publicly_accessible : undefined, size: str(i.after.instance_class) }),
    edges: (i, h) => h.refs(i, ["replicate_source_db"]).filter((t) => t.type === "aws_db_instance").map((t) => ({ from: t, to: i, kind: "dependency" as const, label: "replicates" })),
  },
  ...each(["aws_db_subnet_group", "aws_db_parameter_group", "aws_db_option_group"], intoReferrer("aws_db_instance")),
  aws_s3_bucket: { arm: "s3:bucket" },
  ...each(S3_PIECES, into("bucket")),
  aws_s3_bucket_replication_configuration: {
    fold: ["bucket"],
    edges: (i, h) => {
      const src = h.refs(i, ["bucket"])[0];
      return src ? h.refs(i, ["rule"]).filter((t) => t.type === "aws_s3_bucket" && t !== src).map((t) => ({ from: src, to: t, kind: "dependency" as const, label: "replicates" })) : [];
    },
  },
  aws_backup_vault: { arm: "backup:backup-vault" },
  aws_backup_plan: { fold: ["rule"] },
  aws_backup_selection: into("plan_id"),
  ...each(["aws_backup_vault_policy", "aws_backup_vault_lock_configuration", "aws_backup_vault_notifications"], into("backup_vault_name")),

  // ── Identity ──
  aws_iam_role: { arm: "iam:role" },
  ...each(["aws_iam_instance_profile", "aws_iam_role_policy"], into("role")),
  aws_iam_role_policy_attachment: { fold: ["role"], pull: ["policy_arn"] },
  aws_iam_policy: { arm: "iam:policy" },

  // ── Monitoring ──
  aws_cloudwatch_metric_alarm: { arm: "cloudwatch:alarm", kind: "monitor" },
  // No tagging-API type: folded into the lab's log group (C9).
  aws_cloudwatch_dashboard: { kind: "monitor", foldInto: firstOfType("aws_cloudwatch_log_group") },
  aws_cloudwatch_query_definition: { foldInto: firstOfType("aws_cloudwatch_log_group") },
  aws_cloudwatch_log_group: { arm: "logs:log-group" },
  ...each(["aws_cloudwatch_log_metric_filter", "aws_cloudwatch_log_subscription_filter"], into("log_group_name")),

  // ── Messaging ──
  aws_sns_topic: { arm: "sns:topic" },
  aws_sqs_queue: { arm: "sqs:queue" },
  aws_cloudwatch_event_rule: { arm: "events:rule" },
  aws_sfn_state_machine: { arm: "states:stateMachine" },
  aws_cloudwatch_event_target: {
    fold: ["rule"],
    edges: (i, h) => {
      const rule = h.refs(i, ["rule"])[0];
      return rule ? h.refs(i, ["arn", "target_arn"]).filter((t) => t !== rule).map((t) => ({ from: rule, to: t, kind: "dependency" as const })) : [];
    },
  },
  aws_sns_topic_policy: into("arn"),
  aws_sns_topic_subscription: into("topic_arn"),
  aws_sqs_queue_policy: into("queue_url"),

  // ── Later batches: kinds only ──
  aws_lambda_function: { arm: "lambda:function" },
  aws_dynamodb_table: { arm: "dynamodb:table" },
  aws_ec2_client_vpn_endpoint: { arm: "ec2:client-vpn-endpoint" },

  // ── Batch 2 (labs 06–10) ──
  aws_cloudformation_stack: { arm: "cloudformation:stack" },
  aws_iam_user: { arm: "iam:user" },
  aws_iam_user_login_profile: into("user"),
  aws_iam_user_policy_attachment: { fold: ["user"], pull: ["policy_arn"] },
  aws_kms_key: { arm: "kms:key" },
  aws_kms_alias: into("target_key_id"),
  aws_secretsmanager_secret: { arm: "secretsmanager:secret" },
  ...each(["aws_secretsmanager_secret_version", "aws_secretsmanager_secret_rotation"], into("secret_id")),
  aws_lambda_permission: into("function_name"),
  aws_accessanalyzer_analyzer: { arm: "access-analyzer:analyzer" },
  aws_network_acl: { arm: "ec2:network-acl" },
  ...each(["aws_network_acl_rule", "aws_network_acl_association"], into("network_acl_id")),
  aws_flow_log: { arm: "ec2:vpc-flow-log", kind: "flowLog" },
  aws_route53_zone: { arm: "route53:hostedzone" },
  aws_route53_record: into("zone_id"),
  aws_route53_health_check: { arm: "route53:healthcheck", kind: "monitor" },
  aws_cloudfront_distribution: {
    arm: "cloudfront:distribution",
    edges: (i, h) => h.refs(i, ["origin"]).filter((t) => t.type === "aws_s3_bucket" || t.type === "aws_lb").map((t) => ({ from: i, to: t, kind: "traffic" as const, label: "origin" })),
  },
  aws_cloudfront_origin_access_control: intoReferrer("aws_cloudfront_distribution"),
  aws_ecr_repository: { arm: "ecr:repository" },
  aws_ecr_lifecycle_policy: into("repository"),
  aws_ecs_cluster: { arm: "ecs:cluster" },
  aws_ecs_task_definition: { arm: "ecs:task-definition", ...intoReferrer("aws_ecs_service") },
  aws_ecs_service: { arm: "ecs:service", props: (i) => ({ instances: num(i.after.desired_count) }) },

  // ── Systems Manager and Config: generic cards; their pieces fold in (C9) ──
  aws_config_config_rule: { arm: "config:config-rule" },
  ...each(["aws_config_configuration_recorder", "aws_config_configuration_recorder_status", "aws_config_delivery_channel", "aws_config_remediation_configuration"], { foldInto: firstOfType("aws_config_config_rule") }),
  aws_ssm_patch_baseline: { arm: "ssm:patchbaseline" },
  aws_ssm_patch_group: into("baseline_id"),
  aws_ssm_association: { arm: "ssm:association" },
  aws_ssm_maintenance_window: { arm: "ssm:maintenancewindow" },
  aws_ssm_document: { arm: "ssm:document" },
  aws_ssm_parameter: { arm: "ssm:parameter" },
};
