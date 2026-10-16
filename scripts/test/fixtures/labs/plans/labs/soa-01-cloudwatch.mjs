// scripts/test/fixtures/labs/plans/labs/soa-01-cloudwatch.mjs
//
// Plain English: lab soa-01's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the template
// network, then compute.tf (the instance's role and profile, the interface
// endpoints, vm-app) and monitoring.tf (log group, metric filter, SNS topic,
// three alarms, dashboard, saved query, EventBridge rule). Names built from
// var.lab_id are known at plan; ids, ARNs and anything built from them are
// unknown. IAM documents are literal JSON (ruling P12).

import { ACCOUNT, AWS_PROVIDER_CONFIG, BOUNDARY, al2023Instance, awsData, ctxAws, ref, tagged, templateResources } from "../common-aws.mjs";

export default () => {
  const c = ctxAws("soa-01-cloudwatch", "01");
  const id = c.id;
  const ns = `cloudlabs/${id}`;
  const group = `/cloudlabs/${id}/app`;
  const app = "aws_instance.app";
  const topic = "aws_sns_topic.alerts";
  const logGroup = "aws_cloudwatch_log_group.app";
  const alertsArn = `arn:aws:sns:${c.variables.region}:${ACCOUNT}:lab-${id}-alerts`;
  const subnet = ["aws_subnet.private[0].id", "aws_subnet.private[0]", "aws_subnet.private"];
  const alarm = (key, name, values, extra = {}) => ({
    address: `aws_cloudwatch_metric_alarm.${key}`,
    values: tagged(c, { alarm_name: `lab-${id}-${name}`, evaluation_periods: values.evaluation_periods, period: 60, statistic: values.statistic, threshold: values.threshold, comparison_operator: values.comparison_operator, namespace: values.namespace, metric_name: values.metric_name, alarm_description: values.alarm_description, ...(values.treat_missing_data ? { treat_missing_data: values.treat_missing_data } : {}) }),
    unknown: ["alarm_actions", ...(extra.dimensions ? ["dimensions"] : []), ...(extra.ok ? ["ok_actions"] : [])],
    refs: { alarm_name: ["var.lab_id"], ...(values.namespace.startsWith("cloudlabs") ? { namespace: ["var.lab_id"] } : {}), alarm_actions: ref(topic, "arn"), ...(extra.dimensions ? { dimensions: ref(app, "id") } : {}), ...(extra.ok ? { ok_actions: ref(topic, "arn") } : {}) },
  });
  const endpoint = (key) => ({
    address: `aws_vpc_endpoint.interface["${key}"]`,
    forEach: { references: [], constant_value: ["logs", "monitoring"] },
    values: tagged(c, { service_name: `com.amazonaws.${c.variables.region}.${key}`, vpc_endpoint_type: "Interface", private_dns_enabled: true, tags: { Name: `vpce-${key}` } }),
    unknown: ["vpc_id", "subnet_ids", "security_group_ids"],
    refs: { vpc_id: ref("aws_vpc.lab", "id"), service_name: ["var.region", "each.key"], subnet_ids: subnet, security_group_ids: ref("aws_security_group.endpoints", "id"), tags: ["each.key"] },
  });
  const instance = al2023Instance(c, { key: "app", name: "vm-app", profile: "aws_iam_instance_profile.vm", monitoring: true });
  instance.values.user_data_replace_on_change = false;
  instance.refs.user_data = ["local.cloud_init_base", "local.agent_config", "local.app_script", "local.app_unit"];
  return {
    lab: id,
    variables: c.variables,
    providers: ["aws"],
    providerConfig: AWS_PROVIDER_CONFIG,
    data: awsData(),
    resources: [
      ...templateResources(c),
      // compute.tf
      {
        address: "aws_iam_role.vm",
        values: tagged(c, { name: `lab-${id}-vm`, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY, assume_role_policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }),
        refs: { name: ["var.lab_id"], permissions_boundary: ["local.boundary_arn"] },
      },
      { address: "aws_iam_role_policy_attachment.vm_cloudwatch", values: { role: `lab-${id}-vm`, policy_arn: "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy" }, refs: { role: ref("aws_iam_role.vm", "name") } },
      { address: "aws_iam_instance_profile.vm", values: tagged(c, { name: `lab-${id}-vm`, path: "/cloudlabs-lab/", role: `lab-${id}-vm` }), refs: { name: ["var.lab_id"], role: ref("aws_iam_role.vm", "name") } },
      { address: "aws_security_group.endpoints", values: tagged(c, { name: "lab-endpoints", description: "Interface endpoints: HTTPS from the lab VPC", tags: { Name: "sg-endpoints" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } },
      { address: "aws_vpc_security_group_ingress_rule.endpoints_https", values: tagged(c, { cidr_ipv4: c.vpcCidr, ip_protocol: "tcp", from_port: 443, to_port: 443 }), unknown: ["security_group_id"], refs: { security_group_id: ref("aws_security_group.endpoints", "id"), cidr_ipv4: ["local.vpc_cidr"] } },
      endpoint("logs"),
      endpoint("monitoring"),
      instance,
      // monitoring.tf
      { address: logGroup, values: tagged(c, { name: group, retention_in_days: 1 }), refs: { name: ["var.lab_id"] } },
      {
        address: "aws_cloudwatch_log_metric_filter.errors",
        values: { name: "lab-errors", log_group_name: group, pattern: "ERROR", metric_transformation: [{ name: "AppErrors", namespace: ns, value: "1", default_value: "0" }] },
        refs: { log_group_name: ref(logGroup, "name"), "metric_transformation.0.namespace": ["var.lab_id"] },
      },
      { address: topic, values: tagged(c, { name: `lab-${id}-alerts` }), refs: { name: ["var.lab_id"] } },
      {
        address: "aws_sns_topic_policy.alerts",
        // The policy is known at plan: its Resource is local.alerts_arn, built from the topic's known name, the region
        // and the caller identity (ruling P10: a resource policy is read for who it lets in).
        values: {
          policy: JSON.stringify({
            Statement: [
              { Action: ["sns:GetTopicAttributes", "sns:SetTopicAttributes", "sns:Subscribe", "sns:ListSubscriptionsByTopic", "sns:Publish", "sns:DeleteTopic"], Effect: "Allow", Principal: { AWS: `arn:aws:iam::${ACCOUNT}:root` }, Resource: alertsArn, Sid: "OwnerManages" },
              { Action: "sns:Publish", Condition: { StringEquals: { "aws:SourceAccount": ACCOUNT } }, Effect: "Allow", Principal: { Service: ["events.amazonaws.com", "cloudwatch.amazonaws.com"] }, Resource: alertsArn, Sid: "EventsAndAlarmsOfThisAccount" },
            ],
            Version: "2012-10-17",
          }),
        },
        unknown: ["arn"],
        // In expression order, once per use, as Terraform lists them (a local by its own name; preflight C11).
        refs: {
          arn: ref(topic, "arn"),
          policy: [...ref("data.aws_partition.current", "partition"), ...ref("data.aws_caller_identity.current", "account_id"), "local.alerts_arn", "local.alerts_arn", ...ref("data.aws_caller_identity.current", "account_id")],
        },
      },
      alarm("cpu_high", "cpu-high", { alarm_description: "vm-app's CPU above 70% for two minutes", namespace: "AWS/EC2", metric_name: "CPUUtilization", statistic: "Average", evaluation_periods: 2, threshold: 70, comparison_operator: "GreaterThanThreshold" }, { dimensions: true, ok: true }),
      alarm("app_errors", "app-errors", { alarm_description: "Five or more ERROR lines in a minute", namespace: ns, metric_name: "AppErrors", statistic: "Sum", evaluation_periods: 1, threshold: 5, comparison_operator: "GreaterThanOrEqualToThreshold", treat_missing_data: "notBreaching" }),
      alarm("memory_high", "memory-high", { alarm_description: "vm-app's memory above 80% for two minutes (from the agent)", namespace: ns, metric_name: "mem_used_percent", statistic: "Average", evaluation_periods: 2, threshold: 80, comparison_operator: "GreaterThanThreshold", treat_missing_data: "missing" }, { dimensions: true }),
      {
        address: "aws_cloudwatch_dashboard.overview",
        values: { dashboard_name: `lab-${id}-overview` },
        unknown: ["dashboard_body"],
        // jsonencode's references in expression order, once per use (var.region four times), as the real plan listed them.
        refs: {
          dashboard_name: ["var.lab_id"],
          dashboard_body: ["var.region", ...ref(app, "id"), "var.region", "var.lab_id", ...ref(app, "id"), "var.region", "var.lab_id", "var.region", ...ref(logGroup, "name")],
        },
      },
      {
        address: "aws_cloudwatch_query_definition.errors",
        values: { name: `lab-${id}-errors`, log_group_names: [group], query_string: "fields @timestamp, @message\n| filter @message like /ERROR/\n| sort @timestamp desc\n| limit 50" },
        refs: { name: ["var.lab_id"], log_group_names: ref(logGroup, "name") },
      },
      {
        address: "aws_cloudwatch_event_rule.state",
        values: tagged(c, { name: `lab-${id}-ec2-state`, description: "vm-app starts, stops or terminates" }),
        unknown: ["event_pattern"],
        refs: { name: ["var.lab_id"], event_pattern: ref(app, "id") },
      },
      {
        address: "aws_cloudwatch_event_target.state_sns",
        values: { rule: `lab-${id}-ec2-state`, target_id: "sns" },
        unknown: ["arn"],
        refs: { rule: ref("aws_cloudwatch_event_rule.state", "name"), arn: ref(topic, "arn") },
      },
    ],
  };
};
