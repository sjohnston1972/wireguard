// scripts/test/fixtures/labs/plans/labs/soa-08-vpc-fix.mjs
//
// Plain English: lab soa-08's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the template
// network, then web.tf (vm-web), data.tf (the data VPC, its route table, the
// peering, acl-db, sg-db, the second Instance Connect Endpoint, vm-db) and
// flowlogs.tf (the log group, the flow-log role and the two flow logs). The
// CIDRs are built from var.address_space, so they are known at plan; ids and
// ARNs are not. The database's cloud-init holds the session's password
// (sensitive, known at plan).

import { ACCOUNT, AWS_PROVIDER_CONFIG, BOUNDARY, al2023Instance, awsData, cidrsubnet, ctxAws, ref, tagged, templateResources } from "../common-aws.mjs";

export default () => {
  const c = ctxAws("soa-08-vpc-fix", "08");
  const id = c.id;
  const dataCidr = cidrsubnet(c.address, 2, 1);
  const dbCidr = cidrsubnet(dataCidr, 4, 0);
  const wrongCidr = cidrsubnet(c.vpcCidr, 4, 1);
  const group = `/cloudlabs/${id}/flow`;
  const region = c.variables.region;
  const web = al2023Instance(c, { key: "web", name: "vm-web", type: "t4g.nano" });
  web.values.user_data_replace_on_change = false;
  web.refs.user_data = ["local.cloud_init_base"];
  const db = al2023Instance(c, { key: "db", name: "vm-db", subnet: "aws_subnet.db", sgs: ["aws_security_group.db"] });
  db.values.user_data_replace_on_change = false;
  db.refs.user_data = ["local.cloud_init_base", "local.db_sql"];
  const aclRule = (key, number, egress, cidr, from, to, refs = {}) => ({
    address: `aws_network_acl_rule.${key}`,
    values: { rule_number: number, egress, protocol: "tcp", rule_action: "allow", cidr_block: cidr, from_port: from, to_port: to },
    unknown: ["network_acl_id"],
    refs: { network_acl_id: ref("aws_network_acl.db", "id"), ...refs },
  });
  const flowLog = (key, vpc) => ({
    address: `aws_flow_log.${key}`,
    values: tagged(c, { traffic_type: "ALL", log_destination_type: "cloud-watch-logs", max_aggregation_interval: 60, tags: { Name: `flow-${key}` } }),
    unknown: ["vpc_id", "log_destination", "iam_role_arn"],
    refs: { vpc_id: ref(vpc, "id"), log_destination: ref("aws_cloudwatch_log_group.flow", "arn"), iam_role_arn: ref("aws_iam_role.flowlogs", "arn") },
  });
  return {
    lab: id,
    variables: c.variables,
    providers: ["aws"],
    providerConfig: AWS_PROVIDER_CONFIG,
    data: awsData(),
    resources: [
      ...templateResources(c),
      // web.tf
      web,
      // data.tf
      { address: "aws_vpc.data", values: tagged(c, { cidr_block: dataCidr, enable_dns_support: true, enable_dns_hostnames: true, tags: { Name: "vpc-data" } }), refs: { cidr_block: ["local.data_cidr"] } },
      { address: "aws_subnet.db", values: tagged(c, { cidr_block: dbCidr, availability_zone: "eu-west-2a", map_public_ip_on_launch: false, tags: { Name: "snet-db" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.data", "id"), cidr_block: ["local.db_cidr"], availability_zone: ["local.azs[0]", "local.azs"] } },
      { address: "aws_route_table.data", values: tagged(c, { tags: { Name: "rt-data" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.data", "id") } },
      { address: "aws_route_table_association.db", values: {}, unknown: ["subnet_id", "route_table_id"], refs: { subnet_id: ref("aws_subnet.db", "id"), route_table_id: ref("aws_route_table.data", "id") } },
      { address: "aws_vpc_endpoint.data_s3", values: tagged(c, { service_name: `com.amazonaws.${region}.s3`, vpc_endpoint_type: "Gateway", tags: { Name: "vpce-s3-data" } }), unknown: ["vpc_id", "route_table_ids"], refs: { vpc_id: ref("aws_vpc.data", "id"), service_name: ["var.region"], route_table_ids: ref("aws_route_table.data", "id") } },
      { address: "aws_vpc_peering_connection.app_data", values: tagged(c, { auto_accept: true, tags: { Name: "pcx-app-data" } }), unknown: ["vpc_id", "peer_vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id"), peer_vpc_id: ref("aws_vpc.data", "id") } },
      { address: "aws_route.app_to_data", values: { destination_cidr_block: dataCidr }, unknown: ["route_table_id", "vpc_peering_connection_id"], refs: { route_table_id: ref("aws_route_table.private", "id"), destination_cidr_block: ["local.data_cidr"], vpc_peering_connection_id: ref("aws_vpc_peering_connection.app_data", "id") } },
      { address: "aws_network_acl.db", values: tagged(c, { tags: { Name: "acl-db" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.data", "id") } },
      { address: "aws_network_acl_association.db", values: {}, unknown: ["network_acl_id", "subnet_id"], refs: { network_acl_id: ref("aws_network_acl.db", "id"), subnet_id: ref("aws_subnet.db", "id") } },
      aclRule("in_mysql", 100, false, c.vpcCidr, 3306, 3306, { cidr_block: ["local.vpc_cidr"] }),
      aclRule("in_replies", 110, false, "0.0.0.0/0", 1024, 65535),
      aclRule("out_https", 100, true, "0.0.0.0/0", 443, 443),
      { address: "aws_security_group.eice_data", values: tagged(c, { name: "lab-eice-data", description: "Instance Connect Endpoint in vpc-data: SSH out to vm-db", tags: { Name: "sg-eice-data" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.data", "id") } },
      { address: "aws_vpc_security_group_egress_rule.eice_data_ssh", values: tagged(c, { cidr_ipv4: dataCidr, ip_protocol: "tcp", from_port: 22, to_port: 22 }), unknown: ["security_group_id"], refs: { security_group_id: ref("aws_security_group.eice_data", "id"), cidr_ipv4: ["local.data_cidr"] } },
      { address: "aws_ec2_instance_connect_endpoint.data", values: tagged(c, { preserve_client_ip: false, tags: { Name: "eice-data" } }), unknown: ["subnet_id", "security_group_ids.0"], refs: { subnet_id: ref("aws_subnet.db", "id"), security_group_ids: ref("aws_security_group.eice_data", "id") } },
      { address: "aws_security_group.db", values: tagged(c, { name: "lab-db", description: "vm-db: MySQL from the app VPC, SSH from the Instance Connect Endpoint", tags: { Name: "sg-db" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.data", "id") } },
      { address: "aws_vpc_security_group_ingress_rule.db_ssh", values: tagged(c, { ip_protocol: "tcp", from_port: 22, to_port: 22 }), unknown: ["security_group_id", "referenced_security_group_id"], refs: { security_group_id: ref("aws_security_group.db", "id"), referenced_security_group_id: ref("aws_security_group.eice_data", "id") } },
      { address: "aws_vpc_security_group_ingress_rule.db_mysql", values: tagged(c, { cidr_ipv4: wrongCidr, ip_protocol: "tcp", from_port: 3306, to_port: 3306 }), unknown: ["security_group_id"], refs: { security_group_id: ref("aws_security_group.db", "id"), cidr_ipv4: ["local.wrong_cidr"] } },
      { address: "aws_vpc_security_group_egress_rule.db_all", values: tagged(c, { cidr_ipv4: "0.0.0.0/0", ip_protocol: "-1" }), unknown: ["security_group_id"], refs: { security_group_id: ref("aws_security_group.db", "id") } },
      db,
      // flowlogs.tf
      { address: "aws_cloudwatch_log_group.flow", values: tagged(c, { name: group, retention_in_days: 1 }), refs: { name: ["var.lab_id"] } },
      {
        address: "aws_iam_role.flowlogs",
        values: tagged(c, {
          name: `lab-${id}-flowlogs`, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY,
          assume_role_policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "vpc-flow-logs.amazonaws.com" }, Action: "sts:AssumeRole", Condition: { StringEquals: { "aws:SourceAccount": ACCOUNT } } }] }),
        }),
        refs: { name: ["var.lab_id"], permissions_boundary: ["local.boundary_arn"], assume_role_policy: ref("data.aws_caller_identity.current", "account_id") },
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
        refs: { name: ["var.lab_id"], policy: ["var.region", ...ref("data.aws_caller_identity.current", "account_id"), "var.lab_id"] },
      },
      {
        address: "aws_iam_role_policy_attachment.flowlogs",
        values: { role: `lab-${id}-flowlogs` },
        unknown: ["policy_arn"],
        refs: { role: ref("aws_iam_role.flowlogs", "name"), policy_arn: ref("aws_iam_policy.flowlogs", "arn") },
      },
      flowLog("app", "aws_vpc.lab"),
      flowLog("data", "aws_vpc.data"),
    ],
  };
};
