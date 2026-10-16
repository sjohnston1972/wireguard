// scripts/test/fixtures/labs/plans/labs/saa-16-dr-pilot-light.mjs
//
// Plain English: lab saa-16's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the template
// network, then ireland.tf (the secondary provider's resource group, VPC,
// subnet, route table, S3 endpoint, Instance Connect Endpoint, security
// groups and the DR launch template, every one under aws.secondary and so
// planned in eu-west-1; ruling P5), app.tf (vm-app and its alarm), data.tf
// (the London and Ireland buckets, versioning, the replication role, policy,
// wait and configuration, the first object, and the global table), dns.tf
// (the private zone in both VPCs, the CloudWatch-metric health check and the
// two failover records) and ami.tf (the copy of the public AMI in Ireland).
// Names built from var.lab_id and var.name_prefix are known at plan, as are
// the zone's name (so the records' names), the health check's alarm and the
// standby address; ids, ARNs, the app's address, the copy's id (the launch
// template's image) and the alarm's dimensions are unknown.

import { AMI, AWS_PROVIDER_CONFIG, AWS_SECONDARY, BOUNDARY, al2023Instance, awsData, cidrsubnet, ctxAws, ref, tagged, templateResources } from "../common-aws.mjs";

/** The secondary provider as ireland.tf configures it (ruling P5; lab-scope-aws.test.mjs's P5 configuration). */
const SECONDARY_PROVIDER_CONFIG = {
  "aws.secondary": { name: "aws", full_name: "registry.terraform.io/hashicorp/aws", alias: "secondary", expressions: { alias: { constant_value: "secondary" }, region: { references: ["var.secondary_region"] }, default_tags: [{ tags: { references: ["var.tags"] } }] } },
};

export default () => {
  const c = ctxAws("saa-16-dr-pilot-light", "16");
  const id = c.id;
  const IE = "aws.secondary";
  const drVpc = cidrsubnet(c.address, 2, 1);
  const drSubnet = cidrsubnet(drVpc, 4, 0);
  const drIp = `${drSubnet.split("/")[0].split(".").slice(0, 3).join(".")}.${Number(drSubnet.split("/")[0].split(".")[3]) + 10}`;
  const london = `cloudlabs-${c.prefix}-london`;
  const ireland = `cloudlabs-${c.prefix}-ireland`;
  const londonArn = `arn:aws:s3:::${london}`;
  const irelandArn = `arn:aws:s3:::${ireland}`;
  const zone = `dr.${c.prefix}.internal`;
  const DR_VPC = "aws_vpc.dr";
  const instance = al2023Instance(c, { key: "app", name: "vm-app", type: "t4g.nano" });
  instance.refs.user_data = ["local.app_cloud_init"];
  const onBucket = (type, key, values, extra = {}) => ({
    address: `${type}.${key}`,
    ...(extra.providerKey ? { providerKey: extra.providerKey } : {}),
    values,
    unknown: ["bucket", ...(extra.unknown ?? [])],
    refs: { bucket: ref(`aws_s3_bucket.${extra.bucket ?? key}`, "id"), ...(extra.refs ?? {}) },
  });
  const block = { block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true };
  const versioning = (key, extra) => onBucket("aws_s3_bucket_versioning", key, { versioning_configuration: [{ status: "Enabled" }] }, extra);
  const spec = (type) => ({ resource_type: type, tags: { ...c.tags, Name: "vm-dr" } });
  const record = (key, label, type, extra) => ({
    address: `aws_route53_record.${key}`,
    values: { name: `app.${zone}`, type: "A", ttl: 30, set_identifier: label, failover_routing_policy: [{ type }], ...(extra.values ?? {}) },
    unknown: ["zone_id", ...(extra.unknown ?? [])],
    refs: { zone_id: ref("aws_route53_zone.dr", "zone_id"), name: ref("aws_route53_zone.dr", "name"), ...(extra.refs ?? {}) },
  });
  return {
    lab: id,
    variables: { ...c.variables, secondary_region: AWS_SECONDARY },
    providers: ["aws"],
    providerConfig: { ...AWS_PROVIDER_CONFIG, ...SECONDARY_PROVIDER_CONFIG },
    data: [
      ...awsData(),
      { address: "data.aws_availability_zones.dr", providerKey: IE, values: { state: "available", names: ["eu-west-1a", "eu-west-1b", "eu-west-1c"] }, args: ["state"], refs: {} },
    ],
    resources: [
      ...templateResources(c),
      // ireland.tf
      {
        address: "aws_resourcegroups_group.secondary",
        providerKey: IE,
        values: tagged(c, { name: `lab-${id}`, resource_query: [{ type: "TAG_FILTERS_1_0", query: JSON.stringify({ ResourceTypeFilters: ["AWS::AllSupported"], TagFilters: [{ Key: "cloudlabs-lab", Values: [id] }] }) }] }),
        refs: { name: ["var.lab_id"], "resource_query.0.query": ["var.lab_id"] },
      },
      { address: DR_VPC, providerKey: IE, values: tagged(c, { cidr_block: drVpc, enable_dns_support: true, enable_dns_hostnames: true, tags: { Name: "vpc-dr" } }), refs: { cidr_block: ["local.dr_vpc_cidr"] } },
      {
        address: "aws_subnet.dr",
        providerKey: IE,
        values: tagged(c, { cidr_block: drSubnet, availability_zone: "eu-west-1a", map_public_ip_on_launch: false, tags: { Name: "snet-dr" } }),
        unknown: ["vpc_id"],
        refs: { vpc_id: ref(DR_VPC, "id"), cidr_block: ["local.dr_subnet_cidr"], availability_zone: ["data.aws_availability_zones.dr.names[0]", "data.aws_availability_zones.dr"] },
      },
      { address: "aws_route_table.dr", providerKey: IE, values: tagged(c, { tags: { Name: "rt-dr" } }), unknown: ["vpc_id"], refs: { vpc_id: ref(DR_VPC, "id") } },
      { address: "aws_route_table_association.dr", providerKey: IE, values: {}, unknown: ["subnet_id", "route_table_id"], refs: { subnet_id: ref("aws_subnet.dr", "id"), route_table_id: ref("aws_route_table.dr", "id") } },
      {
        address: "aws_vpc_endpoint.dr_s3",
        providerKey: IE,
        values: tagged(c, { service_name: `com.amazonaws.${AWS_SECONDARY}.s3`, vpc_endpoint_type: "Gateway", tags: { Name: "vpce-s3-dr" } }),
        unknown: ["vpc_id", "route_table_ids"],
        refs: { vpc_id: ref(DR_VPC, "id"), service_name: ["var.secondary_region"], route_table_ids: ref("aws_route_table.dr", "id") },
      },
      { address: "aws_security_group.dr_eice", providerKey: IE, values: tagged(c, { name: "lab-eice-dr", description: "EC2 Instance Connect Endpoint in Ireland: SSH out to the DR instance", tags: { Name: "sg-eice-dr" } }), unknown: ["vpc_id"], refs: { vpc_id: ref(DR_VPC, "id") } },
      {
        address: "aws_vpc_security_group_egress_rule.dr_eice_ssh",
        providerKey: IE,
        values: tagged(c, { cidr_ipv4: drVpc, ip_protocol: "tcp", from_port: 22, to_port: 22 }),
        unknown: ["security_group_id"],
        refs: { security_group_id: ref("aws_security_group.dr_eice", "id"), cidr_ipv4: ["local.dr_vpc_cidr"] },
      },
      {
        address: "aws_ec2_instance_connect_endpoint.dr",
        providerKey: IE,
        values: tagged(c, { preserve_client_ip: false, tags: { Name: "eice-dr" } }),
        unknown: ["subnet_id", "security_group_ids.0"],
        refs: { subnet_id: ref("aws_subnet.dr", "id"), security_group_ids: ref("aws_security_group.dr_eice", "id") },
      },
      { address: "aws_security_group.dr", providerKey: IE, values: tagged(c, { name: "lab-dr", description: "The DR instance: SSH from the Instance Connect Endpoint, HTTP inside its VPC", tags: { Name: "sg-dr" } }), unknown: ["vpc_id"], refs: { vpc_id: ref(DR_VPC, "id") } },
      {
        address: "aws_vpc_security_group_ingress_rule.dr_ssh_eice",
        providerKey: IE,
        values: tagged(c, { ip_protocol: "tcp", from_port: 22, to_port: 22 }),
        unknown: ["security_group_id", "referenced_security_group_id"],
        refs: { security_group_id: ref("aws_security_group.dr", "id"), referenced_security_group_id: ref("aws_security_group.dr_eice", "id") },
      },
      {
        address: "aws_vpc_security_group_ingress_rule.dr_http",
        providerKey: IE,
        values: tagged(c, { cidr_ipv4: drVpc, ip_protocol: "tcp", from_port: 80, to_port: 80 }),
        unknown: ["security_group_id"],
        refs: { security_group_id: ref("aws_security_group.dr", "id"), cidr_ipv4: ["local.dr_vpc_cidr"] },
      },
      { address: "aws_vpc_security_group_egress_rule.dr_all", providerKey: IE, values: tagged(c, { cidr_ipv4: "0.0.0.0/0", ip_protocol: "-1" }), unknown: ["security_group_id"], refs: { security_group_id: ref("aws_security_group.dr", "id") } },
      {
        address: "aws_launch_template.dr",
        providerKey: IE,
        values: tagged(c, {
          name: `lt-${c.prefix}-dr`, instance_type: "t4g.nano", update_default_version: true, user_data: "(base64 of the DR cloud-init)",
          metadata_options: [{ http_tokens: "required", http_endpoint: "enabled" }],
          block_device_mappings: [{ device_name: "/dev/xvda", ebs: [{ volume_size: 8, volume_type: "gp3", delete_on_termination: "true" }] }],
          tag_specifications: [spec("instance"), spec("volume"), spec("network-interface")],
          tags: { Name: "lt-dr" },
        }),
        unknown: ["image_id"],
        sensitive: ["user_data"],
        refs: {
          name: ["var.name_prefix"],
          image_id: ref("aws_ami_copy.dr", "id"),
          user_data: ["local.dr_cloud_init"],
          "tag_specifications.0.tags": ["var.tags"],
          "tag_specifications.1.tags": ["var.tags"],
          "tag_specifications.2.tags": ["var.tags"],
        },
      },
      // app.tf
      instance,
      {
        address: "aws_cloudwatch_metric_alarm.app_down",
        values: tagged(c, {
          alarm_name: `lab-${id}-app-down`, alarm_description: `lab ${id}: the London app's status checks fail, or it stops reporting`,
          namespace: "AWS/EC2", metric_name: "StatusCheckFailed", statistic: "Maximum", period: 60, evaluation_periods: 2, threshold: 1,
          comparison_operator: "GreaterThanOrEqualToThreshold", treat_missing_data: "breaching", tags: { Name: "alarm-app-down" },
        }),
        unknown: ["dimensions"],
        refs: { alarm_name: ["var.lab_id"], alarm_description: ["var.lab_id"], dimensions: ref("aws_instance.app", "id") },
      },
      // data.tf
      { address: "aws_s3_bucket.london", values: tagged(c, { bucket: london, force_destroy: true, tags: { Name: "london" } }), refs: { bucket: ["local.london_bucket"] } },
      { address: "aws_s3_bucket.ireland", providerKey: IE, values: tagged(c, { bucket: ireland, force_destroy: true, tags: { Name: "ireland" } }), refs: { bucket: ["local.ireland_bucket"] } },
      onBucket("aws_s3_bucket_public_access_block", "london", block),
      onBucket("aws_s3_bucket_public_access_block", "ireland", block, { providerKey: IE }),
      versioning("london"),
      versioning("ireland", { providerKey: IE }),
      {
        address: "aws_iam_role.replication",
        values: tagged(c, { name: `lab-${id}-replication`, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY, assume_role_policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "s3.amazonaws.com" }, Action: "sts:AssumeRole" }] }) }),
        refs: { name: ["var.lab_id"], permissions_boundary: ["local.boundary_arn"] },
      },
      {
        address: "aws_iam_policy.replication",
        values: tagged(c, {
          name: `lab-${id}-replication`, path: "/cloudlabs-lab/",
          policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              { Effect: "Allow", Action: ["s3:GetReplicationConfiguration", "s3:ListBucket"], Resource: londonArn },
              { Effect: "Allow", Action: ["s3:GetObjectVersionForReplication", "s3:GetObjectVersionAcl", "s3:GetObjectVersionTagging"], Resource: `${londonArn}/*` },
              { Effect: "Allow", Action: ["s3:ReplicateObject", "s3:ReplicateDelete", "s3:ReplicateTags"], Resource: `${irelandArn}/*` },
            ],
          }),
        }),
        // Locals by their own names, once per use, in expression order.
        refs: { name: ["var.lab_id"], policy: ["local.london_arn", "local.london_arn", "local.ireland_arn"] },
      },
      {
        address: "aws_iam_role_policy_attachment.replication",
        values: { role: `lab-${id}-replication` },
        unknown: ["policy_arn"],
        refs: { role: ref("aws_iam_role.replication", "name"), policy_arn: ref("aws_iam_policy.replication", "arn") },
      },
      { address: "time_sleep.replication_role", values: { create_duration: "20s" }, refs: {} },
      onBucket("aws_s3_bucket_replication_configuration", "london", {
        rule: [{ id: "to-ireland", status: "Enabled", filter: [{}], delete_marker_replication: [{ status: "Enabled" }], destination: [{ storage_class: "STANDARD" }] }],
      }, { unknown: ["role", "rule.0.destination.0.bucket"], refs: { role: ref("aws_iam_role.replication", "arn"), "rule.0.destination.0.bucket": ref("aws_s3_bucket.ireland", "arn") } }),
      onBucket("aws_s3_object", "hello", tagged(c, { key: "hello.txt", content: "written in London, replicated to Ireland\n", content_type: "text/plain" }), { bucket: "london" }),
      {
        address: "aws_dynamodb_table.orders",
        values: tagged(c, {
          name: `lab-${id}-orders`, billing_mode: "PAY_PER_REQUEST", hash_key: "id", stream_enabled: true, stream_view_type: "NEW_AND_OLD_IMAGES", deletion_protection_enabled: false,
          attribute: [{ name: "id", type: "S" }],
          replica: [{ region_name: AWS_SECONDARY, propagate_tags: true }],
          tags: { Name: "table-orders" },
        }),
        refs: { name: ["var.lab_id"], "replica.0.region_name": ["var.secondary_region"] },
      },
      // dns.tf
      {
        address: "aws_route53_zone.dr",
        values: tagged(c, { name: zone, force_destroy: true, vpc: [{ vpc_region: c.variables.region }, { vpc_region: AWS_SECONDARY }], tags: { Name: "zone-dr" } }),
        unknown: ["vpc.0.vpc_id", "vpc.1.vpc_id"],
        refs: { name: ["var.name_prefix"], "vpc.0.vpc_id": ref("aws_vpc.lab", "id"), "vpc.0.vpc_region": ["var.region"], "vpc.1.vpc_id": ref(DR_VPC, "id"), "vpc.1.vpc_region": ["var.secondary_region"] },
      },
      {
        address: "aws_route53_health_check.app",
        values: tagged(c, { type: "CLOUDWATCH_METRIC", cloudwatch_alarm_name: `lab-${id}-app-down`, cloudwatch_alarm_region: c.variables.region, insufficient_data_health_status: "Healthy", tags: { Name: "hc-app" } }),
        refs: { cloudwatch_alarm_name: ref("aws_cloudwatch_metric_alarm.app_down", "alarm_name"), cloudwatch_alarm_region: ["var.region"] },
      },
      record("app_london", "london", "PRIMARY", { unknown: ["records", "health_check_id"], refs: { records: ref("aws_instance.app", "private_ip"), health_check_id: ref("aws_route53_health_check.app", "id") } }),
      record("app_ireland", "ireland", "SECONDARY", { values: { records: [drIp] }, refs: { records: ["local.dr_ip"] } }),
      // ami.tf
      {
        address: "aws_ami_copy.dr",
        providerKey: IE,
        values: tagged(c, { name: `lab-${id}-al2023-${c.prefix}`, description: `lab ${id}: Amazon Linux 2023 (arm64) from London, for a DR launch in Ireland`, source_ami_id: AMI, source_ami_region: c.variables.region, tags: { Name: "ami-dr" } }),
        refs: { name: ["var.lab_id", "var.name_prefix"], description: ["var.lab_id"], source_ami_id: ["data.aws_ssm_parameter.al2023_arm64.insecure_value", "data.aws_ssm_parameter.al2023_arm64"], source_ami_region: ["var.region"] },
      },
    ],
  };
};
