// scripts/test/fixtures/labs/plans/labs/ans-21-transit-gateway.mjs
//
// Plain English: lab ans-21's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the template
// network, then spoke-b.tf (vpc-spoke-b, its subnets, route table, S3 endpoint
// and Instance Connect Endpoint), egress.tf (vpc-egress, the gateways, the NAT
// gateway and the two route tables), tgw.tf (the transit gateway, three
// attachments, two route tables, their associations, propagations and routes,
// and the VPC routes to the transit gateway) and compute.tf (the security
// groups and vm-a, vm-b). Every CIDR is built from var.address_space, so it is
// known at plan; ids are not. Each instance's cloud-init is built from
// var.lab_id and the session's password (known at plan, sensitive).

import { AWS_PROVIDER_CONFIG, al2023Instance, awsData, cidrsubnet, ctxAws, ref, tagged, templateResources } from "../common-aws.mjs";

export default () => {
  const c = ctxAws("ans-21-transit-gateway", "21");
  const id = c.id;
  const b = cidrsubnet(c.address, 2, 1);
  const e = cidrsubnet(c.address, 2, 2);
  const zone = (i) => `eu-west-2${"ab"[i]}`;
  const tgwId = ref("aws_ec2_transit_gateway.lab", "id");
  const ingress = (key, sg, extra, refs = {}, unknown = []) => ({
    address: `aws_vpc_security_group_ingress_rule.${key}`,
    values: tagged(c, extra),
    unknown: ["security_group_id", ...unknown],
    refs: { security_group_id: ref(sg, "id"), ...refs },
  });
  const route = (key, table, values, unknownGw, refGw, refs = {}) => ({
    address: `aws_route.${key}`,
    values,
    unknown: ["route_table_id", unknownGw],
    refs: { route_table_id: ref(table, "id"), [unknownGw]: ref(refGw, "id"), ...refs },
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
  const web = (inst) => {
    inst.refs.user_data = ["local.cloud_init_base", "local.web_unit", "local.web_runcmd"];
    return inst;
  };
  const vmA = web(al2023Instance(c, { key: "a", name: "vm-a", type: "t4g.nano", sgs: ["aws_security_group.vms", "aws_security_group.vms_a"] }));
  const vmB = web(al2023Instance(c, { key: "b", name: "vm-b", subnet: "aws_subnet.spoke_b[0]", type: "t4g.nano", sgs: ["aws_security_group.vms_b"] }));
  const subnetB = (i) => ({
    address: `aws_subnet.spoke_b[${i}]`,
    count: 2,
    values: tagged(c, { cidr_block: cidrsubnet(b, 4, i), availability_zone: zone(i), map_public_ip_on_launch: false, tags: { Name: `snet-spoke-b-${i + 1}` } }),
    unknown: ["vpc_id"],
    refs: { vpc_id: ref("aws_vpc.spoke_b", "id"), cidr_block: ["local.spoke_b_cidr", "count.index"], availability_zone: ["local.azs", "count.index"], tags: ["count.index"] },
  });
  const subnetTgw = (i) => ({
    address: `aws_subnet.egress_tgw[${i}]`,
    count: 2,
    values: tagged(c, { cidr_block: cidrsubnet(e, 4, i), availability_zone: zone(i), map_public_ip_on_launch: false, tags: { Name: `snet-egress-tgw-${i + 1}` } }),
    unknown: ["vpc_id"],
    refs: { vpc_id: ref("aws_vpc.egress", "id"), cidr_block: ["local.egress_cidr", "count.index"], availability_zone: ["local.azs", "count.index"], tags: ["count.index"] },
  });
  return {
    lab: id,
    variables: c.variables,
    providers: ["aws"],
    providerConfig: AWS_PROVIDER_CONFIG,
    data: awsData(),
    resources: [
      ...templateResources(c),
      // spoke-b.tf
      { address: "aws_vpc.spoke_b", values: tagged(c, { cidr_block: b, enable_dns_support: true, enable_dns_hostnames: true, tags: { Name: "vpc-spoke-b" } }), refs: { cidr_block: ["local.spoke_b_cidr"] } },
      subnetB(0),
      subnetB(1),
      { address: "aws_route_table.spoke_b", values: tagged(c, { tags: { Name: "rt-spoke-b" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.spoke_b", "id") } },
      ...[0, 1].map((i) => ({ address: `aws_route_table_association.spoke_b[${i}]`, count: 2, values: {}, unknown: ["subnet_id", "route_table_id"], refs: { subnet_id: ["aws_subnet.spoke_b", "count.index"], route_table_id: ref("aws_route_table.spoke_b", "id") } })),
      { address: "aws_vpc_endpoint.spoke_b_s3", values: tagged(c, { service_name: "com.amazonaws.eu-west-2.s3", vpc_endpoint_type: "Gateway", tags: { Name: "vpce-s3-spoke-b" } }), unknown: ["vpc_id", "route_table_ids"], refs: { vpc_id: ref("aws_vpc.spoke_b", "id"), service_name: ["var.region"], route_table_ids: ref("aws_route_table.spoke_b", "id") } },
      { address: "aws_security_group.eice_spoke_b", values: tagged(c, { name: "lab-eice-spoke-b", description: "Instance Connect Endpoint in vpc-spoke-b: SSH out to vm-b", tags: { Name: "sg-eice-spoke-b" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.spoke_b", "id") } },
      { address: "aws_vpc_security_group_egress_rule.eice_spoke_b_ssh", values: tagged(c, { cidr_ipv4: b, ip_protocol: "tcp", from_port: 22, to_port: 22 }), unknown: ["security_group_id"], refs: { security_group_id: ref("aws_security_group.eice_spoke_b", "id"), cidr_ipv4: ["local.spoke_b_cidr"] } },
      { address: "aws_ec2_instance_connect_endpoint.spoke_b", values: tagged(c, { preserve_client_ip: false, tags: { Name: "eice-spoke-b" } }), unknown: ["subnet_id", "security_group_ids.0"], refs: { subnet_id: ["aws_subnet.spoke_b[0].id", "aws_subnet.spoke_b[0]", "aws_subnet.spoke_b"], security_group_ids: ref("aws_security_group.eice_spoke_b", "id") } },
      // egress.tf
      { address: "aws_vpc.egress", values: tagged(c, { cidr_block: e, enable_dns_support: true, enable_dns_hostnames: true, tags: { Name: "vpc-egress" } }), refs: { cidr_block: ["local.egress_cidr"] } },
      subnetTgw(0),
      subnetTgw(1),
      { address: "aws_subnet.egress_public", values: tagged(c, { cidr_block: cidrsubnet(e, 4, 2), availability_zone: "eu-west-2a", map_public_ip_on_launch: false, tags: { Name: "snet-egress-public" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.egress", "id"), cidr_block: ["local.egress_cidr"], availability_zone: ["local.azs[0]", "local.azs"] } },
      { address: "aws_internet_gateway.egress", values: tagged(c, { tags: { Name: "igw-egress" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.egress", "id") } },
      { address: "aws_route_table.egress_public", values: tagged(c, { tags: { Name: "rt-egress-public" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.egress", "id") } },
      route("egress_public_internet", "aws_route_table.egress_public", { destination_cidr_block: "0.0.0.0/0" }, "gateway_id", "aws_internet_gateway.egress"),
      { address: "aws_route_table_association.egress_public", values: {}, unknown: ["subnet_id", "route_table_id"], refs: { subnet_id: ref("aws_subnet.egress_public", "id"), route_table_id: ref("aws_route_table.egress_public", "id") } },
      { address: "aws_eip.nat", values: tagged(c, { domain: "vpc", tags: { Name: "eip-nat" } }) },
      { address: "aws_nat_gateway.egress", values: tagged(c, { tags: { Name: "nat-egress" } }), unknown: ["allocation_id", "subnet_id"], refs: { allocation_id: ref("aws_eip.nat", "id"), subnet_id: ref("aws_subnet.egress_public", "id") } },
      { address: "aws_route_table.egress_tgw", values: tagged(c, { tags: { Name: "rt-egress-tgw" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.egress", "id") } },
      route("egress_tgw_nat", "aws_route_table.egress_tgw", { destination_cidr_block: "0.0.0.0/0" }, "nat_gateway_id", "aws_nat_gateway.egress"),
      ...[0, 1].map((i) => ({ address: `aws_route_table_association.egress_tgw[${i}]`, count: 2, values: {}, unknown: ["subnet_id", "route_table_id"], refs: { subnet_id: ["aws_subnet.egress_tgw", "count.index"], route_table_id: ref("aws_route_table.egress_tgw", "id") } })),
      // tgw.tf
      { address: "aws_ec2_transit_gateway.lab", values: tagged(c, { description: `lab ${id}: two spokes and central egress`, amazon_side_asn: 64512, auto_accept_shared_attachments: "disable", default_route_table_association: "disable", default_route_table_propagation: "disable", dns_support: "enable", tags: { Name: "tgw-lab" } }), refs: { description: ["var.lab_id"] } },
      att("spoke_a", "tgwa-spoke-a", "aws_vpc.lab", "aws_subnet.private"),
      att("spoke_b", "tgwa-spoke-b", "aws_vpc.spoke_b", "aws_subnet.spoke_b"),
      att("egress", "tgwa-egress", "aws_vpc.egress", "aws_subnet.egress_tgw", { appliance_mode_support: "enable" }),
      tgwTable("spokes", "tgw-rt-spokes"),
      tgwTable("egress", "tgw-rt-egress"),
      link("association", "spoke_a", "spoke_a", "spokes"),
      link("association", "spoke_b", "spoke_b", "spokes"),
      link("association", "egress", "egress", "egress"),
      link("propagation", "spoke_a", "spoke_a", "egress"),
      link("propagation", "spoke_b", "spoke_b", "egress"),
      { address: "aws_ec2_transit_gateway_route.spokes_default", values: { destination_cidr_block: "0.0.0.0/0" }, unknown: ["transit_gateway_attachment_id", "transit_gateway_route_table_id"], refs: { transit_gateway_attachment_id: ref("aws_ec2_transit_gateway_vpc_attachment.egress", "id"), transit_gateway_route_table_id: ref("aws_ec2_transit_gateway_route_table.spokes", "id") } },
      { address: "aws_ec2_transit_gateway_route.spokes_blackhole_b", values: { destination_cidr_block: b, blackhole: true }, unknown: ["transit_gateway_route_table_id"], refs: { destination_cidr_block: ["local.spoke_b_cidr"], transit_gateway_route_table_id: ref("aws_ec2_transit_gateway_route_table.spokes", "id") } },
      route("spoke_a_default", "aws_route_table.private", { destination_cidr_block: "0.0.0.0/0" }, "transit_gateway_id", "aws_ec2_transit_gateway.lab"),
      route("spoke_b_default", "aws_route_table.spoke_b", { destination_cidr_block: "0.0.0.0/0" }, "transit_gateway_id", "aws_ec2_transit_gateway.lab"),
      route("egress_public_slot", "aws_route_table.egress_public", { destination_cidr_block: c.address }, "transit_gateway_id", "aws_ec2_transit_gateway.lab", { destination_cidr_block: ["var.address_space"] }),
      // compute.tf
      { address: "aws_security_group.vms_a", values: tagged(c, { name: "lab-vms-a", description: "vm-a: ping and HTTP from the lab slot", tags: { Name: "sg-vms-a" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } },
      { address: "aws_security_group.vms_b", values: tagged(c, { name: "lab-vms-b", description: "vm-b: ping and HTTP from the lab slot, SSH from the spoke B Instance Connect Endpoint", tags: { Name: "sg-vms-b" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.spoke_b", "id") } },
      ingress("vms_a_icmp", "aws_security_group.vms_a", { cidr_ipv4: c.address, ip_protocol: "icmp", from_port: -1, to_port: -1 }, { cidr_ipv4: ["var.address_space"] }),
      ingress("vms_a_http", "aws_security_group.vms_a", { cidr_ipv4: c.address, ip_protocol: "tcp", from_port: 80, to_port: 80 }, { cidr_ipv4: ["var.address_space"] }),
      ingress("vms_b_icmp", "aws_security_group.vms_b", { cidr_ipv4: c.address, ip_protocol: "icmp", from_port: -1, to_port: -1 }, { cidr_ipv4: ["var.address_space"] }),
      ingress("vms_b_http", "aws_security_group.vms_b", { cidr_ipv4: c.address, ip_protocol: "tcp", from_port: 80, to_port: 80 }, { cidr_ipv4: ["var.address_space"] }),
      ingress("vms_b_ssh_eice", "aws_security_group.vms_b", { ip_protocol: "tcp", from_port: 22, to_port: 22 }, { referenced_security_group_id: ref("aws_security_group.eice_spoke_b", "id") }, ["referenced_security_group_id"]),
      { address: "aws_vpc_security_group_egress_rule.vms_b_all", values: tagged(c, { cidr_ipv4: "0.0.0.0/0", ip_protocol: "-1" }), unknown: ["security_group_id"], refs: { security_group_id: ref("aws_security_group.vms_b", "id") } },
      vmA,
      vmB,
    ],
  };
};
