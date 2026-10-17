// scripts/test/fixtures/labs/plans/labs/ans-29-multi-region.mjs
//
// Plain English: lab ans-29's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the template
// network, then london.tf (tgw-london, its attachment and the two routes in
// rt-private), ireland.tf (the secondary provider's resource group, VPC, two
// subnets with a route table each, the S3 endpoint, Instance Connect
// Endpoint, tgw-ireland and its attachment, every one under aws.secondary and
// so planned in eu-west-1), peering.tf (the transit gateway peering
// attachment and its accepter, the two static routes, the VPC peering and
// its accepter) and compute.tf (the security groups and the three
// instances). Every CIDR is built from var.address_space, so it is known at
// plan; ids are not.

import { AWS_PROVIDER_CONFIG, AWS_SECONDARY, al2023Instance, awsData, cidrsubnet, ctxAws, ref, tagged, templateResources } from "../common-aws.mjs";

/** The secondary provider as ireland.tf configures it (ruling P5; the saa-16 fixture's configuration). */
const SECONDARY_PROVIDER_CONFIG = {
  "aws.secondary": { name: "aws", full_name: "registry.terraform.io/hashicorp/aws", alias: "secondary", expressions: { alias: { constant_value: "secondary" }, region: { references: ["var.secondary_region"] }, default_tags: [{ tags: { references: ["var.tags"] } }] } },
};

export default () => {
  const c = ctxAws("ans-29-multi-region", "29");
  const id = c.id;
  const IE = "aws.secondary";
  const AMI_IE = "ami-0fedcba9876543210";
  const ie = cidrsubnet(c.address, 2, 1);
  const ieTgw = cidrsubnet(ie, 4, 0);
  const iePcx = cidrsubnet(ie, 4, 1);
  const VPC_IE = "aws_vpc.ireland";
  const TGW_L = "aws_ec2_transit_gateway.london";
  const TGW_I = "aws_ec2_transit_gateway.ireland";
  const PCX = "aws_vpc_peering_connection.london_ireland";
  const ACCEPTER = "aws_ec2_transit_gateway_peering_attachment_accepter.ireland";
  const defaultTable = (tgw) => [`${tgw}.association_default_route_table_id`, tgw];
  const onIe = (r) => ({ ...r, providerKey: IE });
  const subnetIe = (key, name, cidr, zone, names, local) => onIe({
    address: `aws_subnet.${key}`,
    values: tagged(c, { cidr_block: cidr, availability_zone: zone, map_public_ip_on_launch: false, tags: { Name: name } }),
    unknown: ["vpc_id"],
    refs: { vpc_id: ref(VPC_IE, "id"), cidr_block: [local], availability_zone: [`data.aws_availability_zones.ireland.${names}`, "data.aws_availability_zones.ireland.names", "data.aws_availability_zones.ireland"] },
  });
  const tgw = (provider, asn, desc, name) => ({
    address: provider === IE ? TGW_I : TGW_L,
    ...(provider === IE ? { providerKey: IE } : {}),
    values: tagged(c, { description: desc, amazon_side_asn: asn, auto_accept_shared_attachments: "disable", default_route_table_association: "enable", default_route_table_propagation: "enable", dns_support: "enable", tags: { Name: name } }),
    refs: { description: ["var.lab_id"] },
  });
  const rule = (kind, key, sg, values, refs = {}, unknown = [], extra = {}) => ({
    address: `aws_vpc_security_group_${kind}_rule.${key}`,
    ...extra,
    values: tagged(c, values),
    unknown: ["security_group_id", ...unknown],
    refs: { security_group_id: ref(sg, "id"), ...refs },
  });
  const web = (inst) => {
    inst.refs.user_data = ["local.cloud_init_base", "local.web_unit", "local.web_runcmd"];
    return inst;
  };
  const ieInstance = (key, name, subnet) => {
    const inst = web(al2023Instance(c, { key, name, subnet, type: "t4g.nano", sgs: ["aws_security_group.vms_ireland"] }));
    inst.providerKey = IE;
    inst.values.ami = AMI_IE;
    inst.refs.ami = ["data.aws_ssm_parameter.al2023_ireland.insecure_value", "data.aws_ssm_parameter.al2023_ireland"];
    return inst;
  };
  return {
    lab: id,
    variables: { ...c.variables, secondary_region: AWS_SECONDARY },
    providers: ["aws"],
    providerConfig: { ...AWS_PROVIDER_CONFIG, ...SECONDARY_PROVIDER_CONFIG },
    data: [
      ...awsData(),
      { address: "data.aws_availability_zones.ireland", providerKey: IE, values: { state: "available", names: ["eu-west-1a", "eu-west-1b", "eu-west-1c"] }, args: ["state"], refs: {} },
      { address: "data.aws_ssm_parameter.al2023_ireland", providerKey: IE, values: { name: "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64", insecure_value: AMI_IE }, args: ["name"], refs: {} },
    ],
    resources: [
      ...templateResources(c),
      // london.tf
      tgw("london", 64512, `lab ${id}: London`, "tgw-london"),
      { address: "aws_ec2_transit_gateway_vpc_attachment.london", values: tagged(c, { tags: { Name: "tgwa-london" } }), unknown: ["transit_gateway_id", "vpc_id", "subnet_ids"], refs: { transit_gateway_id: ref(TGW_L, "id"), vpc_id: ref("aws_vpc.lab", "id"), subnet_ids: ["aws_subnet.private"] } },
      { address: "aws_route.london_to_ireland_tgw", values: { destination_cidr_block: ieTgw }, unknown: ["route_table_id", "transit_gateway_id"], refs: { route_table_id: ref("aws_route_table.private", "id"), transit_gateway_id: ref(TGW_L, "id"), destination_cidr_block: ["local.ireland_tgw_subnet"] } },
      { address: "aws_route.london_to_ireland_pcx", values: { destination_cidr_block: iePcx }, unknown: ["route_table_id", "vpc_peering_connection_id"], refs: { route_table_id: ref("aws_route_table.private", "id"), vpc_peering_connection_id: ref(PCX, "id"), destination_cidr_block: ["local.ireland_pcx_subnet"] } },
      // ireland.tf
      onIe({
        address: "aws_resourcegroups_group.secondary",
        values: tagged(c, { name: `lab-${id}`, resource_query: [{ type: "TAG_FILTERS_1_0", query: JSON.stringify({ ResourceTypeFilters: ["AWS::AllSupported"], TagFilters: [{ Key: "cloudlabs-lab", Values: [id] }] }) }] }),
        refs: { name: ["var.lab_id"], "resource_query.0.query": ["var.lab_id"] },
      }),
      onIe({ address: VPC_IE, values: tagged(c, { cidr_block: ie, enable_dns_support: true, enable_dns_hostnames: true, tags: { Name: "vpc-ireland" } }), refs: { cidr_block: ["local.ireland_cidr"] } }),
      subnetIe("ireland_tgw", "snet-ireland-tgw", ieTgw, "eu-west-1a", "names[0]", "local.ireland_tgw_subnet"),
      subnetIe("ireland_pcx", "snet-ireland-pcx", iePcx, "eu-west-1b", "names[1]", "local.ireland_pcx_subnet"),
      onIe({ address: "aws_route_table.ireland_tgw", values: tagged(c, { tags: { Name: "rt-ireland-tgw" } }), unknown: ["vpc_id"], refs: { vpc_id: ref(VPC_IE, "id") } }),
      onIe({ address: "aws_route_table.ireland_pcx", values: tagged(c, { tags: { Name: "rt-ireland-pcx" } }), unknown: ["vpc_id"], refs: { vpc_id: ref(VPC_IE, "id") } }),
      onIe({ address: "aws_route.ireland_tgw_to_london", values: { destination_cidr_block: c.vpcCidr }, unknown: ["route_table_id", "transit_gateway_id"], refs: { route_table_id: ref("aws_route_table.ireland_tgw", "id"), transit_gateway_id: ref(TGW_I, "id"), destination_cidr_block: ["local.vpc_cidr"] } }),
      onIe({ address: "aws_route.ireland_pcx_to_london", values: { destination_cidr_block: c.vpcCidr }, unknown: ["route_table_id", "vpc_peering_connection_id"], refs: { route_table_id: ref("aws_route_table.ireland_pcx", "id"), vpc_peering_connection_id: ref(PCX, "id"), destination_cidr_block: ["local.vpc_cidr"] } }),
      onIe({ address: "aws_route_table_association.ireland_tgw", values: {}, unknown: ["subnet_id", "route_table_id"], refs: { subnet_id: ref("aws_subnet.ireland_tgw", "id"), route_table_id: ref("aws_route_table.ireland_tgw", "id") } }),
      onIe({ address: "aws_route_table_association.ireland_pcx", values: {}, unknown: ["subnet_id", "route_table_id"], refs: { subnet_id: ref("aws_subnet.ireland_pcx", "id"), route_table_id: ref("aws_route_table.ireland_pcx", "id") } }),
      onIe({
        address: "aws_vpc_endpoint.ireland_s3",
        values: tagged(c, { service_name: `com.amazonaws.${AWS_SECONDARY}.s3`, vpc_endpoint_type: "Gateway", tags: { Name: "vpce-s3-ireland" } }),
        unknown: ["vpc_id", "route_table_ids"],
        refs: { vpc_id: ref(VPC_IE, "id"), service_name: ["var.secondary_region"], route_table_ids: [...ref("aws_route_table.ireland_tgw", "id"), ...ref("aws_route_table.ireland_pcx", "id")] },
      }),
      onIe({ address: "aws_security_group.eice_ireland", values: tagged(c, { name: "lab-eice-ireland", description: "Instance Connect Endpoint in Ireland: SSH out to the Ireland instances", tags: { Name: "sg-eice-ireland" } }), unknown: ["vpc_id"], refs: { vpc_id: ref(VPC_IE, "id") } }),
      rule("egress", "eice_ireland_ssh", "aws_security_group.eice_ireland", { cidr_ipv4: ie, ip_protocol: "tcp", from_port: 22, to_port: 22 }, { cidr_ipv4: ["local.ireland_cidr"] }, [], { providerKey: IE }),
      onIe({
        address: "aws_ec2_instance_connect_endpoint.ireland",
        values: tagged(c, { preserve_client_ip: false, tags: { Name: "eice-ireland" } }),
        unknown: ["subnet_id", "security_group_ids.0"],
        refs: { subnet_id: ref("aws_subnet.ireland_tgw", "id"), security_group_ids: ref("aws_security_group.eice_ireland", "id") },
      }),
      tgw(IE, 64513, `lab ${id}: Ireland`, "tgw-ireland"),
      onIe({
        address: "aws_ec2_transit_gateway_vpc_attachment.ireland",
        values: tagged(c, { tags: { Name: "tgwa-ireland" } }),
        unknown: ["transit_gateway_id", "vpc_id", "subnet_ids"],
        refs: { transit_gateway_id: ref(TGW_I, "id"), vpc_id: ref(VPC_IE, "id"), subnet_ids: ["aws_subnet.ireland_tgw.id", "aws_subnet.ireland_tgw", "aws_subnet.ireland_pcx.id", "aws_subnet.ireland_pcx"] },
      }),
      // peering.tf
      {
        address: "aws_ec2_transit_gateway_peering_attachment.london_ireland",
        values: tagged(c, { peer_region: AWS_SECONDARY, tags: { Name: "tgwp-london-ireland" } }),
        unknown: ["transit_gateway_id", "peer_transit_gateway_id"],
        refs: { transit_gateway_id: ref(TGW_L, "id"), peer_transit_gateway_id: ref(TGW_I, "id"), peer_region: ["var.secondary_region"] },
      },
      onIe({
        address: ACCEPTER,
        values: tagged(c, { tags: { Name: "tgwp-london-ireland" } }),
        unknown: ["transit_gateway_attachment_id"],
        refs: { transit_gateway_attachment_id: ref("aws_ec2_transit_gateway_peering_attachment.london_ireland", "id") },
      }),
      {
        address: "aws_ec2_transit_gateway_route.london_to_ireland",
        values: { destination_cidr_block: ie },
        unknown: ["transit_gateway_attachment_id", "transit_gateway_route_table_id"],
        refs: { destination_cidr_block: ["local.ireland_cidr"], transit_gateway_attachment_id: ref("aws_ec2_transit_gateway_peering_attachment.london_ireland", "id"), transit_gateway_route_table_id: defaultTable(TGW_L) },
      },
      onIe({
        address: "aws_ec2_transit_gateway_route.ireland_to_london",
        values: { destination_cidr_block: c.vpcCidr },
        unknown: ["transit_gateway_attachment_id", "transit_gateway_route_table_id"],
        refs: { destination_cidr_block: ["local.vpc_cidr"], transit_gateway_attachment_id: ref(ACCEPTER, "id"), transit_gateway_route_table_id: defaultTable(TGW_I) },
      }),
      {
        address: PCX,
        values: tagged(c, { peer_region: AWS_SECONDARY, auto_accept: false, tags: { Name: "pcx-london-ireland" } }),
        unknown: ["vpc_id", "peer_vpc_id"],
        refs: { vpc_id: ref("aws_vpc.lab", "id"), peer_vpc_id: ref(VPC_IE, "id"), peer_region: ["var.secondary_region"] },
      },
      onIe({
        address: "aws_vpc_peering_connection_accepter.ireland",
        values: tagged(c, { auto_accept: true, tags: { Name: "pcx-london-ireland" } }),
        unknown: ["vpc_peering_connection_id"],
        refs: { vpc_peering_connection_id: ref(PCX, "id") },
      }),
      // compute.tf
      rule("ingress", "vms_icmp_ireland", "aws_security_group.vms", { cidr_ipv4: ie, ip_protocol: "icmp", from_port: -1, to_port: -1 }, { cidr_ipv4: ["local.ireland_cidr"] }),
      rule("ingress", "vms_http_ireland", "aws_security_group.vms", { cidr_ipv4: ie, ip_protocol: "tcp", from_port: 80, to_port: 80 }, { cidr_ipv4: ["local.ireland_cidr"] }),
      onIe({ address: "aws_security_group.vms_ireland", values: tagged(c, { name: "lab-vms-ireland", description: "Ireland instances: ping and HTTP from London, SSH from the Instance Connect Endpoint", tags: { Name: "sg-vms-ireland" } }), unknown: ["vpc_id"], refs: { vpc_id: ref(VPC_IE, "id") } }),
      rule("ingress", "ireland_icmp_london", "aws_security_group.vms_ireland", { cidr_ipv4: c.vpcCidr, ip_protocol: "icmp", from_port: -1, to_port: -1 }, { cidr_ipv4: ["local.vpc_cidr"] }, [], { providerKey: IE }),
      rule("ingress", "ireland_http_london", "aws_security_group.vms_ireland", { cidr_ipv4: c.vpcCidr, ip_protocol: "tcp", from_port: 80, to_port: 80 }, { cidr_ipv4: ["local.vpc_cidr"] }, [], { providerKey: IE }),
      rule("ingress", "ireland_ssh_eice", "aws_security_group.vms_ireland", { ip_protocol: "tcp", from_port: 22, to_port: 22 }, { referenced_security_group_id: ref("aws_security_group.eice_ireland", "id") }, ["referenced_security_group_id"], { providerKey: IE }),
      rule("egress", "ireland_all", "aws_security_group.vms_ireland", { cidr_ipv4: "0.0.0.0/0", ip_protocol: "-1" }, {}, [], { providerKey: IE }),
      web(al2023Instance(c, { key: "london", name: "vm-london", type: "t4g.nano" })),
      ieInstance("ireland_tgw", "vm-ireland-tgw", "aws_subnet.ireland_tgw"),
      ieInstance("ireland_pcx", "vm-ireland-pcx", "aws_subnet.ireland_pcx"),
    ],
  };
};
