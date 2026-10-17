// scripts/test/fixtures/labs/plans/labs/ans-28-flow-logs-fix.mjs
//
// Plain English: lab ans-28's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the template
// network, then service.tf (vpc-service, its subnets, route table, S3
// endpoint, the peering with a route each way, and the Instance Connect
// Endpoint in snet-svc), nlb.tf (the internal NLB, target group with client IP
// preservation, attachment and listener), acl.tf (acl-svc and its three rules,
// fault 2), flowlogs.tf (the log group, the flow-log role, policy and
// attachment, the CloudWatch flow log, the bucket, its public access block and
// policy, and the S3 flow log), athena.tf (the Glue database and table and the
// workgroup), mirror.tf (the mirror target, filter and its two rules) and
// compute.tf (the security groups, fault 1 among them, and the three
// instances). CIDRs come from var.address_space, so they are known at plan;
// ids and ARNs are not. The bucket's name is known at plan, so the table's
// location and the workgroup's output location are too.

import { ACCOUNT, AWS_PROVIDER_CONFIG, BOUNDARY, al2023Instance, awsData, cidrsubnet, ctxAws, ref, tagged, templateResources } from "../common-aws.mjs";

export default () => {
  const c = ctxAws("ans-28-flow-logs-fix", "28");
  const id = c.id;
  const region = c.variables.region;
  const svcVpc = cidrsubnet(c.address, 2, 1);
  const nlbCidr = cidrsubnet(svcVpc, 4, 0);
  const svcCidr = cidrsubnet(svcVpc, 4, 1);
  const bucket = "cloudlabs-a28k3x9q-flowlogs";
  const bucketArn = `arn:aws:s3:::${bucket}`;
  const group = `/cloudlabs/${id}/flow`;
  const glueDb = `lab_${id.replaceAll("-", "_")}`;
  const subnet = (key, cidr, name, local) => ({
    address: `aws_subnet.${key}`,
    values: tagged(c, { cidr_block: cidr, availability_zone: "eu-west-2a", map_public_ip_on_launch: false, tags: { Name: name } }),
    unknown: ["vpc_id"],
    refs: { vpc_id: ref("aws_vpc.service", "id"), cidr_block: [local], availability_zone: ["local.azs[0]", "local.azs"] },
  });
  const assoc = (key, subnetAddr, table) => ({
    address: `aws_route_table_association.${key}`,
    values: {},
    unknown: ["subnet_id", "route_table_id"],
    refs: { subnet_id: ref(subnetAddr, "id"), route_table_id: ref(table, "id") },
  });
  const aclRule = (key, number, egress, action, cidr, refs = {}) => ({
    address: `aws_network_acl_rule.${key}`,
    values: { rule_number: number, egress, protocol: "-1", rule_action: action, cidr_block: cidr },
    unknown: ["network_acl_id"],
    refs: { network_acl_id: ref("aws_network_acl.svc", "id"), ...refs },
  });
  const sg = (key, name, description, vpc, tagName = `sg-${key}`) => ({
    address: `aws_security_group.${key}`,
    values: tagged(c, { name, description, tags: { Name: tagName } }),
    unknown: ["vpc_id"],
    refs: { vpc_id: ref(vpc, "id") },
  });
  const rule = (kind, key, group_, values, refs = {}, unknown = []) => ({
    address: `aws_vpc_security_group_${kind}_rule.${key}`,
    values: tagged(c, values),
    unknown: ["security_group_id", ...unknown],
    refs: { security_group_id: ref(group_, "id"), ...refs },
  });
  const mirrorRule = (key, direction, portKey, description) => ({
    address: `aws_ec2_traffic_mirror_filter_rule.${key}`,
    values: {
      description, rule_number: 100, rule_action: "accept", traffic_direction: direction, protocol: 6,
      source_cidr_block: c.address, destination_cidr_block: c.address, [portKey]: [{ from_port: 80, to_port: 80 }],
    },
    unknown: ["traffic_mirror_filter_id"],
    refs: { traffic_mirror_filter_id: ref("aws_ec2_traffic_mirror_filter.web", "id"), source_cidr_block: ["var.address_space"], destination_cidr_block: ["var.address_space"] },
  });
  const column = (name, type) => ({ name, type });
  const columns = [
    column("version", "int"), column("account_id", "string"), column("interface_id", "string"), column("srcaddr", "string"), column("dstaddr", "string"),
    column("srcport", "int"), column("dstport", "int"), column("protocol", "bigint"), column("packets", "bigint"), column("bytes", "bigint"),
    column("start", "bigint"), column("end", "bigint"), column("action", "string"), column("log_status", "string"),
  ];
  const partitionKeys = ["aws-account-id", "aws-service", "aws-region", "year", "month", "day", "hour"].map((name) => column(name, "string"));
  const bucketPolicy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      { Sid: "LogDeliveryWrite", Effect: "Allow", Principal: { Service: "delivery.logs.amazonaws.com" }, Action: "s3:PutObject", Resource: `${bucketArn}/AWSLogs/aws-account-id=${ACCOUNT}/*`, Condition: { StringEquals: { "aws:SourceAccount": ACCOUNT } } },
      { Sid: "LogDeliveryAclCheck", Effect: "Allow", Principal: { Service: "delivery.logs.amazonaws.com" }, Action: "s3:GetBucketAcl", Resource: bucketArn, Condition: { StringEquals: { "aws:SourceAccount": ACCOUNT } } },
    ],
  });
  const client = al2023Instance(c, { key: "client", name: "vm-client", type: "t4g.nano", sgs: ["aws_security_group.vms", "aws_security_group.client"] });
  const svc = al2023Instance(c, { key: "svc", name: "vm-svc", type: "t4g.nano", subnet: "aws_subnet.svc", sgs: ["aws_security_group.svc"] });
  svc.refs.user_data = ["local.svc_cloud_init"];
  const monitor = al2023Instance(c, { key: "monitor", name: "vm-monitor", type: "t4g.nano", subnet: "aws_subnet.nlb", sgs: ["aws_security_group.monitor"] });
  return {
    lab: id,
    variables: c.variables,
    providers: ["aws"],
    providerConfig: AWS_PROVIDER_CONFIG,
    data: awsData(),
    resources: [
      ...templateResources(c),
      // service.tf
      { address: "aws_vpc.service", values: tagged(c, { cidr_block: svcVpc, enable_dns_support: true, enable_dns_hostnames: true, tags: { Name: "vpc-service" } }), refs: { cidr_block: ["local.svc_vpc_cidr"] } },
      subnet("nlb", nlbCidr, "snet-nlb", "local.nlb_cidr"),
      subnet("svc", svcCidr, "snet-svc", "local.svc_cidr"),
      { address: "aws_route_table.service", values: tagged(c, { tags: { Name: "rt-service" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.service", "id") } },
      assoc("nlb", "aws_subnet.nlb", "aws_route_table.service"),
      assoc("svc", "aws_subnet.svc", "aws_route_table.service"),
      { address: "aws_vpc_endpoint.service_s3", values: tagged(c, { service_name: `com.amazonaws.${region}.s3`, vpc_endpoint_type: "Gateway", tags: { Name: "vpce-s3-service" } }), unknown: ["vpc_id", "route_table_ids"], refs: { vpc_id: ref("aws_vpc.service", "id"), service_name: ["var.region"], route_table_ids: ref("aws_route_table.service", "id") } },
      { address: "aws_vpc_peering_connection.client_service", values: tagged(c, { auto_accept: true, tags: { Name: "pcx-client-service" } }), unknown: ["vpc_id", "peer_vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id"), peer_vpc_id: ref("aws_vpc.service", "id") } },
      { address: "aws_route.client_to_service", values: { destination_cidr_block: svcVpc }, unknown: ["route_table_id", "vpc_peering_connection_id"], refs: { route_table_id: ref("aws_route_table.private", "id"), destination_cidr_block: ["local.svc_vpc_cidr"], vpc_peering_connection_id: ref("aws_vpc_peering_connection.client_service", "id") } },
      { address: "aws_route.service_to_client", values: { destination_cidr_block: c.vpcCidr }, unknown: ["route_table_id", "vpc_peering_connection_id"], refs: { route_table_id: ref("aws_route_table.service", "id"), destination_cidr_block: ["local.vpc_cidr"], vpc_peering_connection_id: ref("aws_vpc_peering_connection.client_service", "id") } },
      sg("service_eice", "lab-eice-service", "Instance Connect Endpoint in vpc-service: SSH out to vm-svc and vm-monitor", "aws_vpc.service", "sg-eice-service"),
      { address: "aws_vpc_security_group_egress_rule.service_eice_ssh", values: tagged(c, { cidr_ipv4: svcVpc, ip_protocol: "tcp", from_port: 22, to_port: 22 }), unknown: ["security_group_id"], refs: { security_group_id: ref("aws_security_group.service_eice", "id"), cidr_ipv4: ["local.svc_vpc_cidr"] } },
      { address: "aws_ec2_instance_connect_endpoint.service", values: tagged(c, { preserve_client_ip: false, tags: { Name: "eice-service" } }), unknown: ["subnet_id", "security_group_ids.0"], refs: { subnet_id: ref("aws_subnet.svc", "id"), security_group_ids: ref("aws_security_group.service_eice", "id") } },
      // nlb.tf
      {
        address: "aws_lb.svc",
        values: tagged(c, { name: "nlb-a28k3x9q", internal: true, load_balancer_type: "network", enable_deletion_protection: false, tags: { Name: "nlb-svc" } }),
        unknown: ["subnets"],
        refs: { name: ["var.name_prefix"], subnets: ref("aws_subnet.nlb", "id") },
      },
      {
        address: "aws_lb_target_group.svc",
        values: tagged(c, { name: "tg-a28k3x9q", port: 80, protocol: "TCP", preserve_client_ip: "true", tags: { Name: "tg-svc" } }),
        unknown: ["vpc_id"],
        refs: { name: ["var.name_prefix"], vpc_id: ref("aws_vpc.service", "id") },
      },
      {
        address: "aws_lb_target_group_attachment.svc",
        values: { port: 80 },
        unknown: ["target_group_arn", "target_id"],
        refs: { target_group_arn: ref("aws_lb_target_group.svc", "arn"), target_id: ref("aws_instance.svc", "id") },
      },
      {
        address: "aws_lb_listener.svc",
        values: tagged(c, { port: 80, protocol: "TCP", default_action: [{ type: "forward" }], tags: { Name: "listener-svc" } }),
        unknown: ["load_balancer_arn", "default_action.0.target_group_arn"],
        refs: { load_balancer_arn: ref("aws_lb.svc", "arn"), "default_action.0.target_group_arn": ref("aws_lb_target_group.svc", "arn") },
      },
      // acl.tf
      { address: "aws_network_acl.svc", values: tagged(c, { tags: { Name: "acl-svc" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.service", "id") } },
      { address: "aws_network_acl_association.svc", values: {}, unknown: ["network_acl_id", "subnet_id"], refs: { network_acl_id: ref("aws_network_acl.svc", "id"), subnet_id: ref("aws_subnet.svc", "id") } },
      aclRule("in_all", 100, false, "allow", "0.0.0.0/0"),
      aclRule("out_deny_client", 90, true, "deny", c.vpcCidr, { cidr_block: ["local.vpc_cidr"] }),
      aclRule("out_all", 100, true, "allow", "0.0.0.0/0"),
      // flowlogs.tf
      { address: "aws_cloudwatch_log_group.flow", values: tagged(c, { name: group, retention_in_days: 1 }), refs: { name: ["local.flow_group"] } },
      {
        address: "aws_iam_role.flowlogs",
        values: tagged(c, {
          name: `lab-${id}-flowlogs`, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY,
          assume_role_policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "vpc-flow-logs.amazonaws.com" }, Action: "sts:AssumeRole", Condition: { StringEquals: { "aws:SourceAccount": ACCOUNT } } }] }),
        }),
        refs: { name: ["var.lab_id"], permissions_boundary: ["local.boundary_arn"], assume_role_policy: ["local.account"] },
      },
      {
        address: "aws_iam_policy.flowlogs",
        values: tagged(c, {
          name: `lab-${id}-flowlogs`, path: "/cloudlabs-lab/",
          policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              { Sid: "LabFlowLogGroup", Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"], Resource: `arn:aws:logs:${region}:${ACCOUNT}:log-group:${group}:*` },
              { Sid: "FindGroups", Effect: "Allow", Action: "logs:DescribeLogGroups", Resource: "*" },
            ],
          }),
        }),
        refs: { name: ["var.lab_id"], policy: ["local.flow_group_arn"] },
      },
      {
        address: "aws_iam_role_policy_attachment.flowlogs",
        values: { role: `lab-${id}-flowlogs` },
        unknown: ["policy_arn"],
        refs: { role: ref("aws_iam_role.flowlogs", "name"), policy_arn: ref("aws_iam_policy.flowlogs", "arn") },
      },
      {
        address: "aws_flow_log.service",
        values: tagged(c, { traffic_type: "ALL", log_destination_type: "cloud-watch-logs", max_aggregation_interval: 60, tags: { Name: "flow-service" } }),
        unknown: ["vpc_id", "log_destination", "iam_role_arn"],
        refs: { vpc_id: ref("aws_vpc.service", "id"), log_destination: ref("aws_cloudwatch_log_group.flow", "arn"), iam_role_arn: ref("aws_iam_role.flowlogs", "arn") },
      },
      { address: "aws_s3_bucket.flowlogs", values: tagged(c, { bucket, force_destroy: true, tags: { Name: "flowlogs" } }), refs: { bucket: ["local.flowlogs_bucket"] } },
      {
        address: "aws_s3_bucket_public_access_block.flowlogs",
        values: { block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true },
        unknown: ["bucket"],
        refs: { bucket: ref("aws_s3_bucket.flowlogs", "id") },
      },
      {
        address: "aws_s3_bucket_policy.flowlogs",
        values: { policy: bucketPolicy },
        unknown: ["bucket"],
        refs: { bucket: ref("aws_s3_bucket.flowlogs", "id"), policy: ["local.flowlogs_arn", "local.flowlogs_s3_root", "local.account", "local.flowlogs_arn", "local.account"] },
      },
      {
        address: "aws_flow_log.service_s3",
        values: tagged(c, {
          traffic_type: "ALL", log_destination_type: "s3", max_aggregation_interval: 60,
          destination_options: [{ file_format: "plain-text", hive_compatible_partitions: true, per_hour_partition: true }],
          tags: { Name: "flow-service-s3" },
        }),
        unknown: ["vpc_id", "log_destination"],
        refs: { vpc_id: ref("aws_vpc.service", "id"), log_destination: ref("aws_s3_bucket.flowlogs", "arn") },
      },
      // athena.tf
      { address: "aws_glue_catalog_database.flow", values: tagged(c, { name: glueDb, description: `lab ${id}: the flow logs' table`, tags: { Name: "glue-flowlogs" } }), refs: { name: ["local.glue_db"], description: ["var.lab_id"] } },
      {
        address: "aws_glue_catalog_table.flow",
        values: {
          database_name: glueDb,
          name: "vpc_flow_logs", table_type: "EXTERNAL_TABLE", description: `lab ${id}: vpc-service flow logs in S3, partitioned by the hour`,
          parameters: {
            EXTERNAL: "TRUE", "skip.header.line.count": "1", "projection.enabled": "true",
            "projection.aws-account-id.type": "enum", "projection.aws-account-id.values": ACCOUNT,
            "projection.aws-service.type": "enum", "projection.aws-service.values": "vpcflowlogs",
            "projection.aws-region.type": "enum", "projection.aws-region.values": region,
            "projection.year.type": "integer", "projection.year.range": "2026,2036",
            "projection.month.type": "integer", "projection.month.range": "1,12", "projection.month.digits": "2",
            "projection.day.type": "integer", "projection.day.range": "1,31", "projection.day.digits": "2",
            "projection.hour.type": "integer", "projection.hour.range": "0,23", "projection.hour.digits": "2",
          },
          partition_keys: partitionKeys,
          storage_descriptor: [{
            location: `s3://${bucket}/AWSLogs/`,
            input_format: "org.apache.hadoop.mapred.TextInputFormat",
            output_format: "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
            ser_de_info: [{ serialization_library: "org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe", parameters: { "field.delim": " ", "serialization.format": " " } }],
            columns,
          }],
        },
        refs: {
          database_name: ref("aws_glue_catalog_database.flow", "name"),
          description: ["var.lab_id"],
          parameters: ["local.account", "var.region"],
          "storage_descriptor.0.location": ref("aws_s3_bucket.flowlogs", "bucket"),
        },
      },
      {
        address: "aws_athena_workgroup.flow",
        values: tagged(c, {
          name: `lab-${id}-wg`, force_destroy: true,
          configuration: [{
            enforce_workgroup_configuration: true, publish_cloudwatch_metrics_enabled: false, bytes_scanned_cutoff_per_query: 10485760,
            result_configuration: [{ output_location: `s3://${bucket}/athena/` }],
          }],
          tags: { Name: "athena-wg" },
        }),
        refs: { name: ["var.lab_id"], "configuration.0.result_configuration.0.output_location": ref("aws_s3_bucket.flowlogs", "bucket") },
      },
      // mirror.tf
      {
        address: "aws_ec2_traffic_mirror_target.monitor",
        values: tagged(c, { description: `lab ${id}: vm-monitor receives mirrored traffic`, tags: { Name: "mirror-monitor" } }),
        unknown: ["network_interface_id"],
        refs: { description: ["var.lab_id"], network_interface_id: ref("aws_instance.monitor", "primary_network_interface_id") },
      },
      { address: "aws_ec2_traffic_mirror_filter.web", values: tagged(c, { description: `lab ${id}: TCP port 80 inside the slot`, tags: { Name: "mirror-filter-web" } }), refs: { description: ["var.lab_id"] } },
      mirrorRule("in", "ingress", "destination_port_range", "requests to port 80"),
      mirrorRule("out", "egress", "source_port_range", "replies from port 80"),
      // compute.tf
      sg("client", "lab-client", "vm-client: ping from the service VPC", "aws_vpc.lab"),
      rule("ingress", "client_ping", "aws_security_group.client", { cidr_ipv4: svcVpc, ip_protocol: "icmp", from_port: -1, to_port: -1 }, { cidr_ipv4: ["local.svc_vpc_cidr"] }),
      sg("svc", "lab-svc", "vm-svc: HTTP from the NLB subnet, SSH from the Instance Connect Endpoint", "aws_vpc.service"),
      rule("ingress", "svc_http", "aws_security_group.svc", { cidr_ipv4: nlbCidr, ip_protocol: "tcp", from_port: 80, to_port: 80 }, { cidr_ipv4: ["local.nlb_cidr"] }),
      rule("ingress", "svc_ssh", "aws_security_group.svc", { ip_protocol: "tcp", from_port: 22, to_port: 22 }, { referenced_security_group_id: ref("aws_security_group.service_eice", "id") }, ["referenced_security_group_id"]),
      rule("egress", "svc_all", "aws_security_group.svc", { cidr_ipv4: "0.0.0.0/0", ip_protocol: "-1" }),
      sg("monitor", "lab-monitor", "vm-monitor: VXLAN mirror traffic from the service VPC, SSH from the Instance Connect Endpoint", "aws_vpc.service"),
      rule("ingress", "monitor_vxlan", "aws_security_group.monitor", { cidr_ipv4: svcVpc, ip_protocol: "udp", from_port: 4789, to_port: 4789 }, { cidr_ipv4: ["local.svc_vpc_cidr"] }),
      rule("ingress", "monitor_ssh", "aws_security_group.monitor", { ip_protocol: "tcp", from_port: 22, to_port: 22 }, { referenced_security_group_id: ref("aws_security_group.service_eice", "id") }, ["referenced_security_group_id"]),
      rule("egress", "monitor_all", "aws_security_group.monitor", { cidr_ipv4: "0.0.0.0/0", ip_protocol: "-1" }),
      client,
      svc,
      monitor,
    ],
  };
};
