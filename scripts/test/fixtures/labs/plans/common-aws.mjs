// scripts/test/fixtures/labs/plans/common-aws.mjs
//
// Plain English: what every AWS lab's plan fixture shares (AWS labs spec §4):
// a session's values (slot 1, London, an a<NN> name prefix, the cloudlabs
// tags), the aws provider as the template configures it, the data sources
// every lab reads, the template's network (labs/_template-aws) and an Amazon
// Linux 2023 instance as the labs build one. Fake ids only.
//
// An AWS fixture description passes providers: ["aws"] and providerConfig:
// AWS_PROVIDER_CONFIG to realisticPlan. tags_all is planned (known at plan:
// default_tags from var.tags merged with the resource's own) but never
// configured, as the provider computes it (preflight ruling C2).

import { cidrOverlaps, slotCidr } from "../../../../lib/labs.mjs";

export const AWS_REGION = "eu-west-2";
export const AWS_SECONDARY = "eu-west-1";
export const ACCOUNT = "123456789012";
export const BOUNDARY = `arn:aws:iam::${ACCOUNT}:policy/wg-admin-lab-boundary`;
export const AMI = "ami-0123456789abcdef0";
export const GATEWAY_CIDR = "10.50.0.0/16";
export const AWS_PROVIDER_CONFIG = {
  aws: { name: "aws", full_name: "registry.terraform.io/hashicorp/aws", expressions: { region: { references: ["var.region"] }, default_tags: [{ tags: { references: ["var.tags"] } }] } },
};
const sub = (cidr, newbits, n) => {
  const [ip, bits] = cidr.split("/");
  const size = 2 ** (32 - Number(bits) - newbits);
  const start = ip.split(".").reduce((a, x) => a * 256 + Number(x), 0) + n * size;
  return `${[24, 16, 8, 0].map((s) => Math.floor(start / 2 ** s) % 256).join(".")}/${Number(bits) + newbits}`;
};
export { sub as cidrsubnet, cidrOverlaps };

/** A session's values for AWS lab `id` (number `n`, two digits) in slot `slot`. */
export const ctxAws = (id, n, { slot = 1 } = {}) => {
  const tags = { "cloudlabs-lab": id, "cloudlabs-session": "ls-20261015090000-ab12cd", project: "cloudlabs" };
  const address = slotCidr(slot);
  const vpcCidr = sub(address, 2, 0);
  return {
    id, n, tags, address, vpcCidr, prefix: `a${n}k3x9q`,
    variables: { lab_id: id, name_prefix: `a${n}k3x9q`, region: AWS_REGION, secondary_region: "", address_space: address, gateway_cidr: GATEWAY_CIDR, peered: false, tags },
  };
};
/** values with tags_all as the provider plans it: default tags (var.tags) merged with the resource's own. */
export const tagged = (c, values) => ({ ...values, tags_all: { ...c.tags, ...(values.tags ?? {}) } });
export const ref = (address, attr) => [`${address}.${attr}`, address];

/** The data sources the template reads (known at plan). `args`: the constant arguments the configuration sets. */
export const awsData = () => [
  { address: "data.aws_availability_zones.available", values: { state: "available", names: ["eu-west-2a", "eu-west-2b", "eu-west-2c"] }, args: ["state"], refs: {} },
  { address: "data.aws_ssm_parameter.al2023_arm64", values: { name: "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64", insecure_value: AMI }, args: ["name"], refs: {} },
  { address: "data.aws_caller_identity.current", values: { account_id: ACCOUNT }, refs: {} },
  { address: "data.aws_partition.current", values: { partition: "aws" }, refs: {} },
];

/**
 * labs/_template-aws's resources, as its .tf files make them (Task 3). A reference through count.index is printed as
 * Terraform 1.14 prints it: the resource and the key (["aws_subnet.private", "count.index"]). A list attribute holding
 * one unknown id is known in length, only its element unknown (the endpoint's security_group_ids.0); a set attribute
 * (vpc_security_group_ids, route_table_ids) is wholly unknown, as AWS labs batch 1's real plans printed them.
 */
export function templateResources(c) {
  const VPC = "aws_vpc.lab";
  return [
    { address: "aws_resourcegroups_group.lab", values: tagged(c, { name: `lab-${c.id}`, resource_query: [{ type: "TAG_FILTERS_1_0", query: JSON.stringify({ ResourceTypeFilters: ["AWS::AllSupported"], TagFilters: [{ Key: "cloudlabs-lab", Values: [c.id] }] }) }] }), refs: { name: ["var.lab_id"], "resource_query.0.query": ["var.lab_id"] } },
    { address: VPC, values: tagged(c, { cidr_block: c.vpcCidr, enable_dns_support: true, enable_dns_hostnames: true, tags: { Name: "vpc-lab", "cloudlabs-peer": "hub" } }), refs: { cidr_block: ["local.vpc_cidr"] } },
    ...[0, 1].map((i) => ({ address: `aws_subnet.private[${i}]`, count: 2, values: tagged(c, { cidr_block: sub(c.vpcCidr, 4, i), availability_zone: `eu-west-2${"ab"[i]}`, map_public_ip_on_launch: false, tags: { Name: `snet-private-${i + 1}` } }), unknown: ["vpc_id"], refs: { vpc_id: ref(VPC, "id"), cidr_block: ["local.vpc_cidr", "count.index"], availability_zone: ["local.azs", "count.index"], tags: ["count.index"] } })),
    { address: "aws_route_table.private", values: tagged(c, { tags: { Name: "rt-private" } }), unknown: ["vpc_id"], refs: { vpc_id: ref(VPC, "id") } },
    ...[0, 1].map((i) => ({ address: `aws_route_table_association.private[${i}]`, count: 2, values: {}, unknown: ["subnet_id", "route_table_id"], refs: { subnet_id: ["aws_subnet.private", "count.index"], route_table_id: ref("aws_route_table.private", "id") } })),
    { address: "aws_vpc_endpoint.s3", values: tagged(c, { service_name: `com.amazonaws.${AWS_REGION}.s3`, vpc_endpoint_type: "Gateway", tags: { Name: "vpce-s3" } }), unknown: ["vpc_id", "route_table_ids"], refs: { vpc_id: ref(VPC, "id"), service_name: ["var.region"], route_table_ids: ref("aws_route_table.private", "id") } },
    { address: "aws_security_group.eice", values: tagged(c, { name: "lab-eice", description: "EC2 Instance Connect Endpoint: SSH out to the lab instances", tags: { Name: "sg-eice" } }), unknown: ["vpc_id"], refs: { vpc_id: ref(VPC, "id") } },
    { address: "aws_vpc_security_group_egress_rule.eice_ssh", values: tagged(c, { cidr_ipv4: c.vpcCidr, ip_protocol: "tcp", from_port: 22, to_port: 22 }), unknown: ["security_group_id"], refs: { security_group_id: ref("aws_security_group.eice", "id"), cidr_ipv4: ["local.vpc_cidr"] } },
    { address: "aws_ec2_instance_connect_endpoint.lab", values: tagged(c, { preserve_client_ip: false, tags: { Name: "eice-lab" } }), unknown: ["subnet_id", "security_group_ids.0"], refs: { subnet_id: ["aws_subnet.private[0].id", "aws_subnet.private[0]", "aws_subnet.private"], security_group_ids: ref("aws_security_group.eice", "id") } },
    { address: "aws_security_group.vms", values: tagged(c, { name: "lab-vms", description: "Lab instances: SSH from the Instance Connect Endpoint, anything from the gateway when peered", tags: { Name: "sg-vms" } }), unknown: ["vpc_id"], refs: { vpc_id: ref(VPC, "id") } },
    { address: "aws_vpc_security_group_ingress_rule.vms_ssh_eice", values: tagged(c, { ip_protocol: "tcp", from_port: 22, to_port: 22 }), unknown: ["security_group_id", "referenced_security_group_id"], refs: { security_group_id: ref("aws_security_group.vms", "id"), referenced_security_group_id: ref("aws_security_group.eice", "id") } },
    { address: "aws_vpc_security_group_ingress_rule.vms_from_gateway", values: tagged(c, { cidr_ipv4: GATEWAY_CIDR, ip_protocol: "-1" }), unknown: ["security_group_id"], refs: { security_group_id: ref("aws_security_group.vms", "id"), cidr_ipv4: ["var.gateway_cidr"] } },
    { address: "aws_vpc_security_group_egress_rule.vms_all", values: tagged(c, { cidr_ipv4: "0.0.0.0/0", ip_protocol: "-1" }), unknown: ["security_group_id"], refs: { security_group_id: ref("aws_security_group.vms", "id") } },
  ];
}

/** labs/_template-aws/main.tf's resources only (the lab's resource group): a lab with no network.tf (ruling P3). */
export const templateMainResources = (c) => templateResources(c).filter((r) => r.address === "aws_resourcegroups_group.lab");
/** labs/_template-aws/main.tf's data sources only: a lab with no network.tf reads no zones and no AMI (ruling P3). */
export const templateMainData = () => awsData().filter((d) => d.address === "data.aws_caller_identity.current" || d.address === "data.aws_partition.current");

/**
 * An Amazon Linux 2023 instance as the labs build one: IMDSv2, an 8 GiB gp3 root disk, the lab's tags on its volumes,
 * the session's cloud-init. It sets only what the labs' HCL sets (preflight ruling C2): no public IP is the provider's
 * default (unknown at plan, as are disable_api_termination and disable_api_stop).
 * As AWS labs batch 1's real plans printed it (2026-10-15): the cloud-init is built from locals of known values, so
 * user_data is known at plan, and it holds var.admin_password (chpasswd), so the plan marks it sensitive either way;
 * the instance profile's name is set literally in its own block, so iam_instance_profile is known too.
 * opts: { key, name, subnet ("aws_subnet.private[0]"), type ("t4g.micro"), profile (an aws_iam_instance_profile
 * address or null), profileName (that profile's name, known at plan), sgs (security group addresses, default
 * ["aws_security_group.vms"]), monitoring (only when given), volumeName (the volumes' Name tag, default name; null:
 * volume_tags = var.tags alone), userDataUnknown (true when the cloud-init uses an apply-time value, soa-05's
 * database address) }.
 */
export function al2023Instance(c, { key, name, subnet = "aws_subnet.private[0]", type = "t4g.micro", profile = null, profileName = profile ? `lab-${c.id}-${profile.split(".").pop()}` : null, sgs = ["aws_security_group.vms"], monitoring, volumeName = name, userDataUnknown = false }) {
  return {
    address: `aws_instance.${key}`,
    values: tagged(c, {
      ami: AMI, instance_type: type,
      ...(monitoring !== undefined ? { monitoring } : {}),
      ...(userDataUnknown ? {} : { user_data: "(the session's cloud-init)" }),
      ...(profile ? { iam_instance_profile: profileName } : {}),
      metadata_options: [{ http_tokens: "required", http_endpoint: "enabled" }],
      root_block_device: [{ volume_size: 8, volume_type: "gp3", delete_on_termination: true }],
      volume_tags: { ...c.tags, ...(volumeName === null ? {} : { Name: volumeName }) },
      tags: { Name: name },
    }),
    unknown: ["subnet_id", "vpc_security_group_ids", ...(userDataUnknown ? ["user_data"] : [])],
    sensitive: ["user_data"],
    refs: {
      ami: ["data.aws_ssm_parameter.al2023_arm64.insecure_value", "data.aws_ssm_parameter.al2023_arm64"],
      subnet_id: [...new Set([`${subnet}.id`, subnet, subnet.replace(/\[\d+\]$/, "")])],
      vpc_security_group_ids: sgs.flatMap((s) => ref(s, "id")),
      user_data: ["local.cloud_init"],
      volume_tags: ["var.tags"],
      ...(profile ? { iam_instance_profile: ref(profile, "name") } : {}),
    },
  };
}
