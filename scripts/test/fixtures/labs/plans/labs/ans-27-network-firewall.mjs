// scripts/test/fixtures/labs/plans/labs/ans-27-network-firewall.mjs
//
// Plain English: lab ans-27's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the template
// network, then spoke-b.tf (vpc-spoke-b and what hangs off it), inspection.tf
// (vpc-inspection, the NAT gateway, three route tables and the five routes
// through the firewall endpoint), tgw.tf (the transit gateway in appliance
// mode, three attachments, two route tables, their associations, propagations
// and routes), firewall.tf (two rule groups, the policy, the firewall and the
// 20-second wait), logs.tf (the alerts bucket, its policy and the logging
// configuration) and compute.tf (the security groups and vm-a, vm-b). The
// firewall endpoint's id is read from the firewall's own status, so it is
// unknown at plan; the reference list for those routes is the path Terraform
// is expected to print (a drafted guess, without local.fw_endpoint, which the
// scope check cannot read through; recalibrated from a real plan later).

import { ACCOUNT, AWS_PROVIDER_CONFIG, al2023Instance, awsData, cidrsubnet, ctxAws, ref, tagged, templateResources } from "../common-aws.mjs";

export default () => {
  const c = ctxAws("ans-27-network-firewall", "27");
  const id = c.id;
  const spokeB = cidrsubnet(c.address, 2, 1);
  const insp = cidrsubnet(c.address, 2, 2);
  const zone = (i) => `eu-west-2${"ab"[i]}`;
  const bucket = `cloudlabs-${c.prefix}-nfwlogs`;
  const bucketArn = `arn:aws:s3:::${bucket}`;
  const tgwId = ref("aws_ec2_transit_gateway.lab", "id");
  const fwEndpoint = ["aws_networkfirewall_firewall.lab.firewall_status", "aws_networkfirewall_firewall.lab"];
  const route = (key, table, values, unknownGw, refGw, refs = {}) => ({
    address: `aws_route.${key}`,
    values,
    unknown: ["route_table_id", unknownGw],
    refs: { route_table_id: ref(table, "id"), [unknownGw]: refGw, ...refs },
  });
  const att = (key, name, vpc, subnetRef, extra = {}) => ({
    address: `aws_ec2_transit_gateway_vpc_attachment.${key}`,
    values: tagged(c, { transit_gateway_default_route_table_association: false, transit_gateway_default_route_table_propagation: false, ...extra, tags: { Name: name } }),
    unknown: ["transit_gateway_id", "vpc_id", "subnet_ids"],
    refs: { transit_gateway_id: tgwId, vpc_id: ref(vpc, "id"), subnet_ids: [subnetRef] },
  });
  const tgwTable = (key, name) => ({
    address: `aws_ec2_transit_gateway_route_table.${key}`,
    values: tagged(c, { tags: { Name: name } }),
    unknown: ["transit_gateway_id"],
    refs: { transit_gateway_id: tgwId },
  });
  const link = (kind, key, attachment, table) => ({
    address: `aws_ec2_transit_gateway_route_table_${kind}.${key}`,
    values: {},
    unknown: ["transit_gateway_attachment_id", "transit_gateway_route_table_id"],
    refs: { transit_gateway_attachment_id: ref(`aws_ec2_transit_gateway_vpc_attachment.${attachment}`, "id"), transit_gateway_route_table_id: ref(`aws_ec2_transit_gateway_route_table.${table}`, "id") },
  });
  const rule = (key, sg, values) => ({
    address: `aws_vpc_security_group_ingress_rule.${key}`,
    values: tagged(c, values),
    unknown: ["security_group_id"],
    refs: { security_group_id: ref(sg, "id"), cidr_ipv4: ["var.address_space"] },
  });
  const subnetB = (i) => ({
    address: `aws_subnet.spoke_b[${i}]`,
    count: 2,
    values: tagged(c, { cidr_block: cidrsubnet(spokeB, 4, i), availability_zone: zone(i), map_public_ip_on_launch: false, tags: { Name: `snet-spoke-b-${i + 1}` } }),
    unknown: ["vpc_id"],
    refs: { vpc_id: ref("aws_vpc.spoke_b", "id"), cidr_block: ["local.spoke_b_cidr", "count.index"], availability_zone: ["local.azs", "count.index"], tags: ["count.index"] },
  });
  const subnetInsp = (key, n, name) => ({
    address: `aws_subnet.${key}`,
    values: tagged(c, { cidr_block: cidrsubnet(insp, 4, n), availability_zone: "eu-west-2a", map_public_ip_on_launch: false, tags: { Name: name } }),
    unknown: ["vpc_id"],
    refs: { vpc_id: ref("aws_vpc.inspection", "id"), cidr_block: ["local.insp_cidr"], availability_zone: ["local.azs"] },
  });
  const inspTable = (key, name) => ({ address: `aws_route_table.${key}`, values: tagged(c, { tags: { Name: name } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.inspection", "id") } });
  const inspAssoc = (key, subnet) => ({ address: `aws_route_table_association.${key}`, values: {}, unknown: ["subnet_id", "route_table_id"], refs: { subnet_id: ref(`aws_subnet.${subnet}`, "id"), route_table_id: ref(`aws_route_table.${subnet}`, "id") } });
  const onBucket = (type, key, values, extra = {}) => ({ address: `${type}.${key}`, values, unknown: ["bucket"], refs: { bucket: ref("aws_s3_bucket.nfwlogs", "id"), ...extra } });
  const delivery = (sid, action, resource, extra = {}) => ({
    Action: action,
    Condition: { StringEquals: { "aws:SourceAccount": ACCOUNT } },
    Effect: "Allow",
    Principal: { Service: "delivery.logs.amazonaws.com" },
    Resource: resource,
    Sid: sid,
    ...extra,
  });
  const web = (inst, which) => {
    inst.refs.user_data = [`local.${which}_cloud_init`];
    return inst;
  };
  const vmA = web(al2023Instance(c, { key: "a", name: "vm-a", type: "t4g.nano", sgs: ["aws_security_group.vms", "aws_security_group.vms_a"] }), "a");
  const vmB = web(al2023Instance(c, { key: "b", name: "vm-b", type: "t4g.nano", subnet: "aws_subnet.spoke_b[0]", sgs: ["aws_security_group.vms_b"] }), "b");
  return {
    lab: id,
    variables: c.variables,
    providers: ["aws"],
    providerConfig: AWS_PROVIDER_CONFIG,
    data: awsData(),
    resources: [
      ...templateResources(c),
      // spoke-b.tf
      { address: "aws_vpc.spoke_b", values: tagged(c, { cidr_block: spokeB, enable_dns_support: true, enable_dns_hostnames: true, tags: { Name: "vpc-spoke-b" } }), refs: { cidr_block: ["local.spoke_b_cidr"] } },
      subnetB(0),
      subnetB(1),
      { address: "aws_route_table.spoke_b", values: tagged(c, { tags: { Name: "rt-spoke-b" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.spoke_b", "id") } },
      ...[0, 1].map((i) => ({ address: `aws_route_table_association.spoke_b[${i}]`, count: 2, values: {}, unknown: ["subnet_id", "route_table_id"], refs: { subnet_id: ["aws_subnet.spoke_b", "count.index"], route_table_id: ref("aws_route_table.spoke_b", "id") } })),
      { address: "aws_vpc_endpoint.spoke_b_s3", values: tagged(c, { service_name: "com.amazonaws.eu-west-2.s3", vpc_endpoint_type: "Gateway", tags: { Name: "vpce-s3-spoke-b" } }), unknown: ["vpc_id", "route_table_ids"], refs: { vpc_id: ref("aws_vpc.spoke_b", "id"), service_name: ["var.region"], route_table_ids: ref("aws_route_table.spoke_b", "id") } },
      { address: "aws_security_group.spoke_b_eice", values: tagged(c, { name: "lab-eice-spoke-b", description: "Instance Connect Endpoint in vpc-spoke-b: SSH out to vm-b", tags: { Name: "sg-eice-spoke-b" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.spoke_b", "id") } },
      { address: "aws_vpc_security_group_egress_rule.spoke_b_eice_ssh", values: tagged(c, { cidr_ipv4: spokeB, ip_protocol: "tcp", from_port: 22, to_port: 22 }), unknown: ["security_group_id"], refs: { security_group_id: ref("aws_security_group.spoke_b_eice", "id"), cidr_ipv4: ["local.spoke_b_cidr"] } },
      { address: "aws_ec2_instance_connect_endpoint.spoke_b", values: tagged(c, { preserve_client_ip: false, tags: { Name: "eice-spoke-b" } }), unknown: ["subnet_id", "security_group_ids.0"], refs: { subnet_id: ["aws_subnet.spoke_b[0].id", "aws_subnet.spoke_b[0]", "aws_subnet.spoke_b"], security_group_ids: ref("aws_security_group.spoke_b_eice", "id") } },
      // inspection.tf
      { address: "aws_vpc.inspection", values: tagged(c, { cidr_block: insp, enable_dns_support: true, enable_dns_hostnames: true, tags: { Name: "vpc-inspection" } }), refs: { cidr_block: ["local.insp_cidr"] } },
      subnetInsp("insp_tgw", 0, "snet-insp-tgw"),
      subnetInsp("insp_firewall", 1, "snet-insp-firewall"),
      subnetInsp("insp_public", 2, "snet-insp-public"),
      { address: "aws_internet_gateway.inspection", values: tagged(c, { tags: { Name: "igw-inspection" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.inspection", "id") } },
      { address: "aws_eip.nat", values: tagged(c, { domain: "vpc", tags: { Name: "eip-nat" } }) },
      { address: "aws_nat_gateway.inspection", values: tagged(c, { tags: { Name: "nat-inspection" } }), unknown: ["allocation_id", "subnet_id"], refs: { allocation_id: ref("aws_eip.nat", "id"), subnet_id: ref("aws_subnet.insp_public", "id") } },
      inspTable("insp_tgw", "rt-insp-tgw"),
      inspTable("insp_firewall", "rt-insp-firewall"),
      inspTable("insp_public", "rt-insp-public"),
      route("insp_tgw_default", "aws_route_table.insp_tgw", { destination_cidr_block: "0.0.0.0/0" }, "vpc_endpoint_id", fwEndpoint),
      route("insp_firewall_default", "aws_route_table.insp_firewall", { destination_cidr_block: "0.0.0.0/0" }, "nat_gateway_id", ref("aws_nat_gateway.inspection", "id")),
      route("insp_firewall_slot", "aws_route_table.insp_firewall", { destination_cidr_block: c.address }, "transit_gateway_id", tgwId, { destination_cidr_block: ["var.address_space"] }),
      route("insp_public_default", "aws_route_table.insp_public", { destination_cidr_block: "0.0.0.0/0" }, "gateway_id", ref("aws_internet_gateway.inspection", "id")),
      route("insp_public_slot", "aws_route_table.insp_public", { destination_cidr_block: c.address }, "vpc_endpoint_id", fwEndpoint, { destination_cidr_block: ["var.address_space"] }),
      inspAssoc("insp_tgw", "insp_tgw"),
      inspAssoc("insp_firewall", "insp_firewall"),
      inspAssoc("insp_public", "insp_public"),
      // tgw.tf
      { address: "aws_ec2_transit_gateway.lab", values: tagged(c, { description: `lab ${id}: spokes through the inspection VPC`, auto_accept_shared_attachments: "disable", default_route_table_association: "disable", default_route_table_propagation: "disable", dns_support: "enable", tags: { Name: "tgw-lab" } }), refs: { description: ["var.lab_id"] } },
      att("spoke_a", "tgwa-spoke-a", "aws_vpc.lab", "aws_subnet.private"),
      att("spoke_b", "tgwa-spoke-b", "aws_vpc.spoke_b", "aws_subnet.spoke_b"),
      att("inspection", "tgwa-inspection", "aws_vpc.inspection", "aws_subnet.insp_tgw.id", { appliance_mode_support: "enable" }),
      tgwTable("spokes", "tgw-rt-spokes"),
      tgwTable("inspection", "tgw-rt-inspection"),
      link("association", "spoke_a", "spoke_a", "spokes"),
      link("association", "spoke_b", "spoke_b", "spokes"),
      link("association", "inspection", "inspection", "inspection"),
      link("propagation", "spoke_a", "spoke_a", "inspection"),
      link("propagation", "spoke_b", "spoke_b", "inspection"),
      { address: "aws_ec2_transit_gateway_route.spokes_default", values: { destination_cidr_block: "0.0.0.0/0" }, unknown: ["transit_gateway_attachment_id", "transit_gateway_route_table_id"], refs: { transit_gateway_attachment_id: ref("aws_ec2_transit_gateway_vpc_attachment.inspection", "id"), transit_gateway_route_table_id: ref("aws_ec2_transit_gateway_route_table.spokes", "id") } },
      route("private_tgw", "aws_route_table.private", { destination_cidr_block: "0.0.0.0/0" }, "transit_gateway_id", tgwId),
      route("spoke_b_tgw", "aws_route_table.spoke_b", { destination_cidr_block: "0.0.0.0/0" }, "transit_gateway_id", tgwId),
      // firewall.tf
      {
        address: "aws_networkfirewall_rule_group.stateless",
        values: tagged(c, {
          name: `lab-${id}-stateless`,
          description: "Drop ping from spoke B to spoke A; send everything else to the stateful engine",
          type: "STATELESS",
          capacity: 10,
          rule_group: [{
            rules_source: [{
              stateless_rules_and_custom_actions: [{
                stateless_rule: [
                  { priority: 1, rule_definition: [{ actions: ["aws:drop"], match_attributes: [{ protocols: [1], source: [{ address_definition: spokeB }], destination: [{ address_definition: c.vpcCidr }] }] }] },
                  { priority: 10, rule_definition: [{ actions: ["aws:forward_to_sfe"], match_attributes: [{ source: [{ address_definition: "0.0.0.0/0" }], destination: [{ address_definition: "0.0.0.0/0" }] }] }] },
                ],
              }],
            }],
          }],
          tags: { Name: "nfw-stateless" },
        }),
        refs: { name: ["var.lab_id"], "rule_group.0.rules_source.0.stateless_rules_and_custom_actions.0.stateless_rule.0.rule_definition.0.match_attributes.0.source.0.address_definition": ["local.spoke_b_cidr"], "rule_group.0.rules_source.0.stateless_rules_and_custom_actions.0.stateless_rule.0.rule_definition.0.match_attributes.0.destination.0.address_definition": ["local.vpc_cidr"] },
      },
      {
        address: "aws_networkfirewall_rule_group.domains",
        values: tagged(c, {
          name: `lab-${id}-domains`,
          description: "Allow HTTP and TLS only to AWS and Ubuntu domains",
          type: "STATEFUL",
          capacity: 100,
          rule_group: [{
            rule_variables: [{ ip_sets: [{ key: "HOME_NET", ip_set: [{ definition: [c.address] }] }] }],
            rules_source: [{ rules_source_list: [{ generated_rules_type: "ALLOWLIST", target_types: ["HTTP_HOST", "TLS_SNI"], targets: [".amazonaws.com", ".amazon.com", ".ubuntu.com"] }] }],
            stateful_rule_options: [{ rule_order: "STRICT_ORDER" }],
          }],
          tags: { Name: "nfw-domains" },
        }),
        refs: { name: ["var.lab_id"], "rule_group.0.rule_variables.0.ip_sets.0.ip_set.0.definition": ["var.address_space"] },
      },
      {
        address: "aws_networkfirewall_firewall_policy.lab",
        values: tagged(c, {
          name: `lab-${id}-policy`,
          description: `lab ${id}: the stateless group, then the domain allow-list, then drop established`,
          firewall_policy: [{
            stateless_default_actions: ["aws:forward_to_sfe"],
            stateless_fragment_default_actions: ["aws:forward_to_sfe"],
            stateful_default_actions: ["aws:drop_established", "aws:alert_established"],
            stateless_rule_group_reference: [{ priority: 1 }],
            stateful_engine_options: [{ rule_order: "STRICT_ORDER" }],
            stateful_rule_group_reference: [{ priority: 1 }],
          }],
          tags: { Name: "nfw-policy" },
        }),
        unknown: ["firewall_policy.0.stateless_rule_group_reference.0.resource_arn", "firewall_policy.0.stateful_rule_group_reference.0.resource_arn"],
        refs: {
          name: ["var.lab_id"],
          description: ["var.lab_id"],
          "firewall_policy.0.stateless_rule_group_reference.0.resource_arn": ref("aws_networkfirewall_rule_group.stateless", "arn"),
          "firewall_policy.0.stateful_rule_group_reference.0.resource_arn": ref("aws_networkfirewall_rule_group.domains", "arn"),
        },
      },
      {
        address: "aws_networkfirewall_firewall.lab",
        values: tagged(c, {
          name: `lab-${id}`,
          description: `lab ${id}: inspects the spokes through the transit gateway`,
          delete_protection: false,
          subnet_change_protection: false,
          firewall_policy_change_protection: false,
          subnet_mapping: [{}],
          tags: { Name: "nfw-lab" },
        }),
        unknown: ["firewall_policy_arn", "vpc_id", "subnet_mapping.0.subnet_id"],
        refs: {
          name: ["var.lab_id"],
          description: ["var.lab_id"],
          firewall_policy_arn: ref("aws_networkfirewall_firewall_policy.lab", "arn"),
          vpc_id: ref("aws_vpc.inspection", "id"),
          "subnet_mapping.0.subnet_id": ref("aws_subnet.insp_firewall", "id"),
        },
      },
      { address: "time_sleep.firewall_tags", values: { create_duration: "20s" }, refs: {} },
      // logs.tf
      { address: "aws_s3_bucket.nfwlogs", values: tagged(c, { bucket, force_destroy: true, tags: { Name: "nfwlogs" } }), refs: { bucket: ["local.nfw_bucket"] } },
      onBucket("aws_s3_bucket_public_access_block", "nfwlogs", { block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true }),
      onBucket("aws_s3_bucket_policy", "nfwlogs", {
        policy: JSON.stringify({
          Statement: [
            delivery("LogDeliveryWrite", "s3:PutObject", `${bucketArn}/alerts/AWSLogs/${ACCOUNT}/*`),
            delivery("LogDeliveryAclCheck", "s3:GetBucketAcl", bucketArn),
          ],
          Version: "2012-10-17",
        }),
      }, { policy: ["local.nfw_arn", "data.aws_caller_identity.current.account_id", "data.aws_caller_identity.current"] }),
      {
        address: "aws_networkfirewall_logging_configuration.lab",
        values: { logging_configuration: [{ log_destination_config: [{ log_destination_type: "S3", log_type: "ALERT", log_destination: { prefix: "alerts" } }] }] },
        unknown: ["firewall_arn", "logging_configuration.0.log_destination_config.0.log_destination.bucketName"],
        refs: { firewall_arn: ref("aws_networkfirewall_firewall.lab", "arn"), "logging_configuration.0.log_destination_config.0.log_destination": ref("aws_s3_bucket.nfwlogs", "bucket") },
      },
      // compute.tf
      { address: "aws_security_group.vms_a", values: tagged(c, { name: "lab-vms-a", description: "vm-a: ping and HTTP from the lab slot", tags: { Name: "sg-vms-a" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } },
      rule("vms_a_ping", "aws_security_group.vms_a", { cidr_ipv4: c.address, ip_protocol: "icmp", from_port: -1, to_port: -1 }),
      rule("vms_a_http", "aws_security_group.vms_a", { cidr_ipv4: c.address, ip_protocol: "tcp", from_port: 80, to_port: 80 }),
      { address: "aws_security_group.vms_b", values: tagged(c, { name: "lab-vms-b", description: "vm-b: ping and HTTP from the lab slot, SSH from the Instance Connect Endpoint", tags: { Name: "sg-vms-b" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.spoke_b", "id") } },
      rule("vms_b_ping", "aws_security_group.vms_b", { cidr_ipv4: c.address, ip_protocol: "icmp", from_port: -1, to_port: -1 }),
      rule("vms_b_http", "aws_security_group.vms_b", { cidr_ipv4: c.address, ip_protocol: "tcp", from_port: 80, to_port: 80 }),
      { address: "aws_vpc_security_group_ingress_rule.vms_b_ssh", values: tagged(c, { ip_protocol: "tcp", from_port: 22, to_port: 22 }), unknown: ["security_group_id", "referenced_security_group_id"], refs: { security_group_id: ref("aws_security_group.vms_b", "id"), referenced_security_group_id: ref("aws_security_group.spoke_b_eice", "id") } },
      { address: "aws_vpc_security_group_egress_rule.vms_b_all", values: tagged(c, { cidr_ipv4: "0.0.0.0/0", ip_protocol: "-1" }), unknown: ["security_group_id"], refs: { security_group_id: ref("aws_security_group.vms_b", "id") } },
      vmA,
      vmB,
    ],
  };
};
