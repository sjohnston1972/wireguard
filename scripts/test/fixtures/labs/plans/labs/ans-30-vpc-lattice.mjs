// scripts/test/fixtures/labs/plans/labs/ans-30-vpc-lattice.mjs
//
// Plain English: lab ans-30's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the template
// network, then svc-b-vpc.tf (the second VPC, its subnets, route table, S3
// endpoint and Instance Connect Endpoint), iam.tf (the client role, its invoke
// policy, attachment and profile), lattice.tf (the service network, two
// services, two instance target groups, the 20-second wait, the attachments,
// listeners, associations and the two auth policies) and compute.tf (the
// target security groups and the three instances). Both auth policies are
// built from the caller identity and the role's fixed path and name, so they
// are known at plan (rulings P7, P19); ids and ARNs of Lattice items are not.

import { ACCOUNT, AWS_PROVIDER_CONFIG, BOUNDARY, GATEWAY_CIDR, al2023Instance, awsData, cidrsubnet, ctxAws, ref, tagged, templateResources } from "../common-aws.mjs";

/** A policy document as Terraform's jsonencode prints it: object keys in sorted order. */
const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
const doc = (statements) => JSON.stringify(sorted({ Version: "2012-10-17", Statement: statements }));

export default () => {
  const c = ctxAws("ans-30-vpc-lattice", "30");
  const id = c.id;
  const svcB = cidrsubnet(c.address, 2, 1);
  const role = `arn:aws:iam::${ACCOUNT}:role/cloudlabs-lab/lab-ans-30-vpc-lattice-client`;
  const LIST = "pl-0123456789abcdef0";
  const SB = "aws_vpc.svc_b";
  const subnetB = (i) => ({
    address: `aws_subnet.svc_b[${i}]`,
    count: 2,
    values: tagged(c, { cidr_block: cidrsubnet(svcB, 4, i), availability_zone: `eu-west-2${"ab"[i]}`, map_public_ip_on_launch: false, tags: { Name: `snet-svc-b-${i + 1}` } }),
    unknown: ["vpc_id"],
    refs: { vpc_id: ref(SB, "id"), cidr_block: ["local.svc_b_cidr", "count.index"], availability_zone: ["local.azs", "count.index"], tags: ["count.index"] },
  });
  const assocB = (i) => ({ address: `aws_route_table_association.svc_b[${i}]`, count: 2, values: {}, unknown: ["subnet_id", "route_table_id"], refs: { subnet_id: ["aws_subnet.svc_b", "count.index"], route_table_id: ref("aws_route_table.svc_b", "id") } });
  const rule = (kind, key, sg, values, refs = {}, unknown = []) => ({
    address: `aws_vpc_security_group_${kind}_rule.${key}`,
    values: tagged(c, values),
    unknown: ["security_group_id", ...unknown],
    refs: { security_group_id: ref(sg, "id"), ...refs },
  });
  const targets = (side, vpc, eice) => {
    const sg = `aws_security_group.targets_${side}`;
    const tcp = (port) => ({ ip_protocol: "tcp", from_port: port, to_port: port });
    return [
      { address: sg, values: tagged(c, { name: `lab-targets-${side}`, description: `vm-svc-${side}: HTTP from VPC Lattice, SSH from the Instance Connect Endpoint, SSH and HTTP from the gateway`, tags: { Name: `sg-targets-${side}` } }), unknown: ["vpc_id"], refs: { vpc_id: ref(vpc, "id") } },
      rule("ingress", `targets_${side}_lattice`, sg, { prefix_list_id: LIST, ...tcp(80) }, { prefix_list_id: ref("data.aws_ec2_managed_prefix_list.lattice", "id") }),
      rule("ingress", `targets_${side}_ssh_eice`, sg, tcp(22), { referenced_security_group_id: ref(eice, "id") }, ["referenced_security_group_id"]),
      rule("ingress", `targets_${side}_ssh_gateway`, sg, { cidr_ipv4: GATEWAY_CIDR, ...tcp(22) }, { cidr_ipv4: ["var.gateway_cidr"] }),
      rule("ingress", `targets_${side}_http_gateway`, sg, { cidr_ipv4: GATEWAY_CIDR, ...tcp(80) }, { cidr_ipv4: ["var.gateway_cidr"] }),
      rule("egress", `targets_${side}_all`, sg, { cidr_ipv4: "0.0.0.0/0", ip_protocol: "-1" }),
    ];
  };
  const targetGroup = (key, vpc) => ({
    address: `aws_vpclattice_target_group.${key}`,
    values: tagged(c, { name: `lab-${id}-tg-${key}`, type: "INSTANCE", config: [{ port: 80, protocol: "HTTP", health_check: [{ enabled: true, protocol: "HTTP", port: 80, path: "/" }] }], tags: { Name: `tg-${key}` } }),
    unknown: ["config.0.vpc_identifier"],
    refs: { name: ["var.lab_id"], "config.0.vpc_identifier": ref(vpc, "id") },
  });
  const attachment = (key, instance) => ({
    address: `aws_vpclattice_target_group_attachment.${key}`,
    values: { target: [{ port: 80 }] },
    unknown: ["target_group_identifier", "target.0.id"],
    refs: { target_group_identifier: ref(`aws_vpclattice_target_group.${key}`, "id"), "target.0.id": ref(instance, "id") },
  });
  const listener = (key) => ({
    address: `aws_vpclattice_listener.${key}`,
    values: tagged(c, { name: "http-80", protocol: "HTTP", port: 80, default_action: [{ forward: [{ target_groups: [{ weight: 100 }] }] }], tags: { Name: `listener-${key}` } }),
    unknown: ["service_identifier", "default_action.0.forward.0.target_groups.0.target_group_identifier"],
    refs: { service_identifier: ref(`aws_vpclattice_service.${key}`, "id"), "default_action.0.forward.0.target_groups.0.target_group_identifier": ref(`aws_vpclattice_target_group.${key}`, "id") },
  });
  const service = (key) => ({
    address: `aws_vpclattice_service.${key}`,
    values: tagged(c, { name: `lab-${id}-svc-${key}`, auth_type: "AWS_IAM", tags: { Name: `svc-${key}` } }),
    refs: { name: ["var.lab_id"] },
  });
  const serviceAssociation = (key) => ({
    address: `aws_vpclattice_service_network_service_association.${key}`,
    values: tagged(c, { tags: { Name: `sn-svc-${key}` } }),
    unknown: ["service_identifier", "service_network_identifier"],
    refs: { service_identifier: ref(`aws_vpclattice_service.${key}`, "id"), service_network_identifier: ref("aws_vpclattice_service_network.lab", "id") },
  });
  const authPolicy = (key, resource, statement) => ({
    address: `aws_vpclattice_auth_policy.${key}`,
    values: { policy: doc([statement]) },
    unknown: ["resource_identifier"],
    refs: { resource_identifier: ref(resource, "arn"), policy: ["local.client_role_arn"] },
  });
  const web = (inst, key) => {
    inst.refs.user_data = [`local.web_cloud_init["${key}"]`, "local.web_cloud_init"];
    return inst;
  };
  return {
    lab: id,
    variables: c.variables,
    providers: ["aws"],
    providerConfig: AWS_PROVIDER_CONFIG,
    data: [
      ...awsData(),
      { address: "data.aws_ec2_managed_prefix_list.lattice", values: { name: "com.amazonaws.eu-west-2.vpc-lattice", id: LIST, entries: [] }, args: [], refs: { name: ["var.region"] } },
    ],
    resources: [
      ...templateResources(c),
      // svc-b-vpc.tf
      { address: SB, values: tagged(c, { cidr_block: svcB, enable_dns_support: true, enable_dns_hostnames: true, tags: { Name: "vpc-svc-b" } }), refs: { cidr_block: ["local.svc_b_cidr"] } },
      subnetB(0),
      subnetB(1),
      { address: "aws_route_table.svc_b", values: tagged(c, { tags: { Name: "rt-svc-b" } }), unknown: ["vpc_id"], refs: { vpc_id: ref(SB, "id") } },
      assocB(0),
      assocB(1),
      { address: "aws_vpc_endpoint.svc_b_s3", values: tagged(c, { service_name: "com.amazonaws.eu-west-2.s3", vpc_endpoint_type: "Gateway", tags: { Name: "vpce-s3-svc-b" } }), unknown: ["vpc_id", "route_table_ids"], refs: { vpc_id: ref(SB, "id"), service_name: ["var.region"], route_table_ids: ref("aws_route_table.svc_b", "id") } },
      { address: "aws_security_group.eice_svc_b", values: tagged(c, { name: "lab-eice-svc-b", description: "Instance Connect Endpoint in vpc-svc-b: SSH out to vm-svc-b", tags: { Name: "sg-eice-svc-b" } }), unknown: ["vpc_id"], refs: { vpc_id: ref(SB, "id") } },
      rule("egress", "eice_svc_b_ssh", "aws_security_group.eice_svc_b", { cidr_ipv4: svcB, ip_protocol: "tcp", from_port: 22, to_port: 22 }, { cidr_ipv4: ["local.svc_b_cidr"] }),
      { address: "aws_ec2_instance_connect_endpoint.svc_b", values: tagged(c, { preserve_client_ip: false, tags: { Name: "eice-svc-b" } }), unknown: ["subnet_id", "security_group_ids.0"], refs: { subnet_id: ["aws_subnet.svc_b[0].id", "aws_subnet.svc_b[0]", "aws_subnet.svc_b"], security_group_ids: ref("aws_security_group.eice_svc_b", "id") } },
      // iam.tf
      {
        address: "aws_iam_role.client",
        values: { name: `lab-${id}-client`, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY, assume_role_policy: doc([{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }]), tags_all: c.tags },
        refs: { name: ["var.lab_id"], permissions_boundary: ["local.boundary_arn"] },
      },
      {
        address: "aws_iam_policy.invoke",
        values: tagged(c, { name: `lab-${id}-invoke`, path: "/cloudlabs-lab/", policy: doc([{ Sid: "InvokeLatticeServices", Effect: "Allow", Action: "vpc-lattice-svcs:Invoke", Resource: `arn:aws:vpc-lattice:eu-west-2:${ACCOUNT}:service/*` }]) }),
        refs: { name: ["var.lab_id"], policy: ["var.region", ...ref("data.aws_caller_identity.current", "account_id")] },
      },
      { address: "aws_iam_role_policy_attachment.client", values: {}, unknown: ["role", "policy_arn"], refs: { role: ref("aws_iam_role.client", "name"), policy_arn: ref("aws_iam_policy.invoke", "arn") } },
      { address: "aws_iam_instance_profile.client", values: tagged(c, { name: `lab-${id}-client`, path: "/cloudlabs-lab/" }), unknown: ["role"], refs: { name: ["var.lab_id"], role: ref("aws_iam_role.client", "name") } },
      // lattice.tf
      { address: "aws_security_group.lattice", values: tagged(c, { name: "lab-lattice", description: "Association of vpc-lab with the service network: HTTP from vpc-lab", tags: { Name: "sg-lattice" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } },
      rule("ingress", "lattice_http", "aws_security_group.lattice", { cidr_ipv4: c.vpcCidr, ip_protocol: "tcp", from_port: 80, to_port: 80 }, { cidr_ipv4: ["local.vpc_cidr"] }),
      { address: "aws_vpclattice_service_network.lab", values: tagged(c, { name: `lab-${id}-sn`, auth_type: "AWS_IAM", tags: { Name: "sn-lab" } }), refs: { name: ["var.lab_id"] } },
      service("a"),
      service("b"),
      targetGroup("a", "aws_vpc.lab"),
      targetGroup("b", SB),
      { address: "time_sleep.lattice_tags", values: { create_duration: "20s" }, refs: {} },
      attachment("a", "aws_instance.svc_a"),
      attachment("b", "aws_instance.svc_b"),
      listener("a"),
      listener("b"),
      serviceAssociation("a"),
      serviceAssociation("b"),
      {
        address: "aws_vpclattice_service_network_vpc_association.lab",
        values: tagged(c, { tags: { Name: "sn-vpc-lab" } }),
        unknown: ["vpc_identifier", "service_network_identifier", "security_group_ids"],
        refs: { vpc_identifier: ref("aws_vpc.lab", "id"), service_network_identifier: ref("aws_vpclattice_service_network.lab", "id"), security_group_ids: ref("aws_security_group.lattice", "id") },
      },
      authPolicy("network", "aws_vpclattice_service_network.lab", { Sid: "LabClientOnly", Effect: "Allow", Principal: { AWS: role }, Action: "vpc-lattice-svcs:Invoke", Resource: "*" }),
      authPolicy("svc_a", "aws_vpclattice_service.a", { Sid: "LabClientGetOnly", Effect: "Allow", Principal: { AWS: role }, Action: "vpc-lattice-svcs:Invoke", Resource: "*", Condition: { StringEquals: { "vpc-lattice-svcs:RequestMethod": "GET" } } }),
      // compute.tf
      ...targets("a", "aws_vpc.lab", "aws_security_group.eice"),
      ...targets("b", SB, "aws_security_group.eice_svc_b"),
      web(al2023Instance(c, { key: "client", name: "vm-client", type: "t4g.nano", profile: "aws_iam_instance_profile.client" }), "client"),
      web(al2023Instance(c, { key: "svc_a", name: "vm-svc-a", type: "t4g.nano", subnet: "aws_subnet.private[1]", sgs: ["aws_security_group.targets_a"] }), "svc_a"),
      web(al2023Instance(c, { key: "svc_b", name: "vm-svc-b", type: "t4g.nano", subnet: "aws_subnet.svc_b[0]", sgs: ["aws_security_group.targets_b"] }), "svc_b"),
    ],
  };
};
