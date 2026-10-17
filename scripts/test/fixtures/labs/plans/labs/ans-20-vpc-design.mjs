// scripts/test/fixtures/labs/plans/labs/ans-20-vpc-design.mjs
//
// Plain English: lab ans-20's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the template
// network, then ipam.tf (the Free Tier IPAM, its Amazon-provided IPv6 pool,
// the pool's /52 and vpc-lab's /56), dual.tf (the secondary IPv4 range, the
// three dual-stack subnets, the gateways, the NAT gateway, the route tables
// and the prefix list) and compute.tf (sg-dual and vm-dual). Every CIDR is
// built from var.address_space, so it is known at plan; ids, the scope id and
// the IPv6 ranges (which the pool hands out) are not. vm-dual's cloud-init is
// built from var.lab_id and the session's password (known at plan, sensitive).

import { AWS_PROVIDER_CONFIG, GATEWAY_CIDR, al2023Instance, awsData, cidrsubnet, ctxAws, ref, tagged, templateResources } from "../common-aws.mjs";

export default () => {
  const c = ctxAws("ans-20-vpc-design", "20");
  const id = c.id;
  const sec = cidrsubnet(c.address, 2, 1);
  const rule = (key, sg, extra, refs = {}, unknown = []) => ({
    address: `aws_vpc_security_group_${key}`,
    values: tagged(c, extra),
    unknown: ["security_group_id", ...unknown],
    refs: { security_group_id: ref(sg, "id"), ...refs },
  });
  const route = (key, table, values, unknownGw, refGw) => ({
    address: `aws_route.${key}`,
    values,
    unknown: ["route_table_id", unknownGw],
    refs: { route_table_id: ref(table, "id"), [unknownGw]: ref(refGw, "id") },
  });
  const dual = al2023Instance(c, { key: "dual", name: "vm-dual", subnet: "aws_subnet.dual[0]", type: "t4g.nano", sgs: ["aws_security_group.dual"] });
  dual.values.ipv6_address_count = 1;
  dual.refs.user_data = ["local.dual_cloud_init"];
  const dualSubnet = (i) => ({
    address: `aws_subnet.dual[${i}]`,
    count: 2,
    values: tagged(c, { cidr_block: cidrsubnet(sec, 4, i), assign_ipv6_address_on_creation: true, availability_zone: `eu-west-2${"ab"[i]}`, map_public_ip_on_launch: false, tags: { Name: `snet-dual-${i + 1}` } }),
    unknown: ["vpc_id", "ipv6_cidr_block"],
    refs: { vpc_id: ref("aws_vpc.lab", "id"), cidr_block: ["local.secondary_cidr", "count.index"], ipv6_cidr_block: ["local.vpc_ipv6_cidr", "count.index"], availability_zone: ["local.azs", "count.index"], tags: ["count.index"] },
  });
  return {
    lab: id,
    variables: c.variables,
    providers: ["aws"],
    providerConfig: AWS_PROVIDER_CONFIG,
    data: awsData(),
    resources: [
      ...templateResources(c),
      // ipam.tf
      { address: "aws_vpc_ipam.lab", values: tagged(c, { description: `lab ${id}: Free Tier IPAM in the session region`, tier: "free", cascade: true, operating_regions: [{ region_name: "eu-west-2" }], tags: { Name: "ipam-lab" } }), refs: { description: ["var.lab_id"], "operating_regions.0.region_name": ["var.region"] } },
      { address: "aws_vpc_ipam_pool.v6", values: tagged(c, { description: `lab ${id}: Amazon-provided IPv6 for VPCs in the session region`, address_family: "ipv6", locale: "eu-west-2", public_ip_source: "amazon", aws_service: "ec2", tags: { Name: "pool-v6" } }), unknown: ["ipam_scope_id"], refs: { description: ["var.lab_id"], ipam_scope_id: ref("aws_vpc_ipam.lab", "public_default_scope_id"), locale: ["var.region"] } },
      { address: "aws_vpc_ipam_pool_cidr.v6", values: { netmask_length: 52 }, unknown: ["ipam_pool_id"], refs: { ipam_pool_id: ref("aws_vpc_ipam_pool.v6", "id") } },
      { address: "aws_vpc_ipv6_cidr_block_association.lab", values: { ipv6_netmask_length: 56 }, unknown: ["vpc_id", "ipv6_ipam_pool_id"], refs: { vpc_id: ref("aws_vpc.lab", "id"), ipv6_ipam_pool_id: ref("aws_vpc_ipam_pool.v6", "id") } },
      // dual.tf
      { address: "aws_vpc_ipv4_cidr_block_association.secondary", values: { cidr_block: sec }, unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id"), cidr_block: ["local.secondary_cidr"] } },
      dualSubnet(0),
      dualSubnet(1),
      { address: "aws_subnet.public", values: tagged(c, { cidr_block: cidrsubnet(sec, 4, 2), assign_ipv6_address_on_creation: true, availability_zone: "eu-west-2a", map_public_ip_on_launch: false, tags: { Name: "snet-public" } }), unknown: ["vpc_id", "ipv6_cidr_block"], refs: { vpc_id: ref("aws_vpc.lab", "id"), cidr_block: ["local.secondary_cidr"], ipv6_cidr_block: ["local.vpc_ipv6_cidr"], availability_zone: ["local.azs"] } },
      { address: "aws_internet_gateway.lab", values: tagged(c, { tags: { Name: "igw-lab" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } },
      { address: "aws_egress_only_internet_gateway.lab", values: tagged(c, { tags: { Name: "eigw-lab" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } },
      { address: "aws_route_table.public", values: tagged(c, { tags: { Name: "rt-public" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } },
      { address: "aws_route_table.dual", values: tagged(c, { tags: { Name: "rt-dual" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } },
      route("public_v4", "aws_route_table.public", { destination_cidr_block: "0.0.0.0/0" }, "gateway_id", "aws_internet_gateway.lab"),
      route("public_v6", "aws_route_table.public", { destination_ipv6_cidr_block: "::/0" }, "gateway_id", "aws_internet_gateway.lab"),
      { address: "aws_route_table_association.public", values: {}, unknown: ["subnet_id", "route_table_id"], refs: { subnet_id: ref("aws_subnet.public", "id"), route_table_id: ref("aws_route_table.public", "id") } },
      { address: "aws_eip.nat", values: tagged(c, { domain: "vpc", tags: { Name: "eip-nat" } }) },
      { address: "aws_nat_gateway.lab", values: tagged(c, { tags: { Name: "nat-lab" } }), unknown: ["allocation_id", "subnet_id"], refs: { allocation_id: ref("aws_eip.nat", "id"), subnet_id: ref("aws_subnet.public", "id") } },
      route("dual_v4", "aws_route_table.dual", { destination_cidr_block: "0.0.0.0/0" }, "nat_gateway_id", "aws_nat_gateway.lab"),
      route("dual_v6", "aws_route_table.dual", { destination_ipv6_cidr_block: "::/0" }, "egress_only_gateway_id", "aws_egress_only_internet_gateway.lab"),
      ...[0, 1].map((i) => ({ address: `aws_route_table_association.dual[${i}]`, count: 2, values: {}, unknown: ["subnet_id", "route_table_id"], refs: { subnet_id: ["aws_subnet.dual", "count.index"], route_table_id: ref("aws_route_table.dual", "id") } })),
      { address: "aws_ec2_managed_prefix_list.admin", values: tagged(c, { name: `lab-${id}-admin`, address_family: "IPv4", max_entries: 4, entry: [{ cidr: GATEWAY_CIDR, description: "the WireGuard server VPC" }, { cidr: c.vpcCidr, description: "vpc-lab primary" }], tags: { Name: "pl-admin" } }), refs: { name: ["var.lab_id"], "entry.0.cidr": ["var.gateway_cidr"], "entry.1.cidr": ["local.vpc_cidr"] } },
      rule("egress_rule.eice_ssh_secondary", "aws_security_group.eice", { cidr_ipv4: sec, ip_protocol: "tcp", from_port: 22, to_port: 22 }, { cidr_ipv4: ["local.secondary_cidr"] }),
      // compute.tf
      { address: "aws_security_group.dual", values: tagged(c, { name: "lab-dual", description: "vm-dual: SSH and HTTP from the admin prefix list, SSH from the Instance Connect Endpoint", tags: { Name: "sg-dual" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } },
      rule("ingress_rule.dual_ssh_admin", "aws_security_group.dual", { ip_protocol: "tcp", from_port: 22, to_port: 22 }, { prefix_list_id: ref("aws_ec2_managed_prefix_list.admin", "id") }, ["prefix_list_id"]),
      rule("ingress_rule.dual_http_admin", "aws_security_group.dual", { ip_protocol: "tcp", from_port: 80, to_port: 80 }, { prefix_list_id: ref("aws_ec2_managed_prefix_list.admin", "id") }, ["prefix_list_id"]),
      rule("ingress_rule.dual_ssh_eice", "aws_security_group.dual", { ip_protocol: "tcp", from_port: 22, to_port: 22 }, { referenced_security_group_id: ref("aws_security_group.eice", "id") }, ["referenced_security_group_id"]),
      rule("egress_rule.dual_all_v4", "aws_security_group.dual", { cidr_ipv4: "0.0.0.0/0", ip_protocol: "-1" }),
      rule("egress_rule.dual_all_v6", "aws_security_group.dual", { cidr_ipv6: "::/0", ip_protocol: "-1" }),
      dual,
    ],
  };
};
