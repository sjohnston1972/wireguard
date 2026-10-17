// scripts/test/fixtures/labs/plans/labs/ans-22-s2s-vpn.mjs
//
// Plain English: lab ans-22's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the template
// network, then onprem.tf (the pretend data centre's VPC, subnet, internet
// gateway, route table, S3 endpoint and Instance Connect Endpoint), vpn.tf
// (the virtual private gateway and its propagation, the customer gateway, the
// two pre-shared keys and the VPN connection), router.tf (the Elastic IP and
// its association with the router's own interface, sg-router, that interface
// and the Ubuntu router on it) and compute.tf (sg-aws and
// vm-aws). Every CIDR is built from var.address_space, so it is known at plan;
// the router's address is fixed in its subnet. The connection's tunnel
// addresses and the router's user data (which holds them, the inside
// addresses, the keys and the Elastic IP) are not known until apply.

import { AWS_PROVIDER_CONFIG, al2023Instance, awsData, cidrsubnet, ctxAws, ref, tagged, templateResources } from "../common-aws.mjs";

export default () => {
  const c = ctxAws("ans-22-s2s-vpn", "22");
  const o = cidrsubnet(c.address, 2, 1);
  const os = cidrsubnet(o, 4, 0);
  const routerIp = `${os.split("/")[0].split(".").slice(0, 3).join(".")}.${Number(os.split("/")[0].split(".")[3]) + 10}`;
  const UBUNTU = "ami-0a1b2c3d4e5f60718";
  const rule = (kind, key, sg, values, refs = {}, unknown = []) => ({
    address: `aws_vpc_security_group_${kind}_rule.${key}`,
    values: tagged(c, values),
    unknown: ["security_group_id", ...unknown],
    refs: { security_group_id: ref(sg, "id"), ...refs },
  });
  const tunnelRule = (key, n, port) =>
    rule("ingress", key, "aws_security_group.router", { ip_protocol: "udp", from_port: port, to_port: port }, { cidr_ipv4: ref("aws_vpn_connection.lab", `tunnel${n}_address`) }, ["cidr_ipv4"]);
  const router = al2023Instance(c, { key: "router", name: "vm-router", subnet: "aws_subnet.onprem", type: "t4g.micro", sgs: ["aws_security_group.router"], userDataUnknown: true });
  router.values.ami = UBUNTU;
  router.values.primary_network_interface = [{}];
  router.unknown = ["primary_network_interface.0.network_interface_id", "user_data"];
  delete router.refs.subnet_id;
  delete router.refs.vpc_security_group_ids;
  router.refs.ami = ["data.aws_ssm_parameter.ubuntu_arm64.insecure_value", "data.aws_ssm_parameter.ubuntu_arm64"];
  router.refs["primary_network_interface.0.network_interface_id"] = ref("aws_network_interface.router", "id");
  router.refs.user_data = ["local.router_cloud_init"];
  const aws = al2023Instance(c, { key: "aws", name: "vm-aws", type: "t4g.nano", sgs: ["aws_security_group.vms", "aws_security_group.aws"] });
  aws.refs.user_data = ["local.aws_cloud_init"];
  return {
    lab: c.id,
    variables: c.variables,
    providers: ["aws"],
    providerConfig: AWS_PROVIDER_CONFIG,
    data: [
      ...awsData(),
      { address: "data.aws_ssm_parameter.ubuntu_arm64", values: { name: "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id", insecure_value: UBUNTU }, args: ["name"], refs: {} },
    ],
    resources: [
      ...templateResources(c),
      // onprem.tf
      { address: "aws_vpc.onprem", values: tagged(c, { cidr_block: o, enable_dns_support: true, enable_dns_hostnames: true, tags: { Name: "vpc-onprem" } }), refs: { cidr_block: ["local.onprem_cidr"] } },
      { address: "aws_subnet.onprem", values: tagged(c, { cidr_block: os, availability_zone: "eu-west-2a", map_public_ip_on_launch: false, tags: { Name: "snet-onprem" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.onprem", "id"), cidr_block: ["local.onprem_subnet_cidr"], availability_zone: ["local.azs"] } },
      { address: "aws_internet_gateway.onprem", values: tagged(c, { tags: { Name: "igw-onprem" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.onprem", "id") } },
      { address: "aws_route_table.onprem", values: tagged(c, { tags: { Name: "rt-onprem" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.onprem", "id") } },
      { address: "aws_route.onprem_internet", values: { destination_cidr_block: "0.0.0.0/0" }, unknown: ["route_table_id", "gateway_id"], refs: { route_table_id: ref("aws_route_table.onprem", "id"), gateway_id: ref("aws_internet_gateway.onprem", "id") } },
      { address: "aws_route.onprem_to_aws", values: { destination_cidr_block: c.vpcCidr }, unknown: ["route_table_id", "network_interface_id"], refs: { route_table_id: ref("aws_route_table.onprem", "id"), destination_cidr_block: ["local.vpc_cidr"], network_interface_id: ref("aws_instance.router", "primary_network_interface_id") } },
      { address: "aws_route_table_association.onprem", values: {}, unknown: ["subnet_id", "route_table_id"], refs: { subnet_id: ref("aws_subnet.onprem", "id"), route_table_id: ref("aws_route_table.onprem", "id") } },
      { address: "aws_vpc_endpoint.onprem_s3", values: tagged(c, { service_name: "com.amazonaws.eu-west-2.s3", vpc_endpoint_type: "Gateway", tags: { Name: "vpce-s3-onprem" } }), unknown: ["vpc_id", "route_table_ids"], refs: { vpc_id: ref("aws_vpc.onprem", "id"), service_name: ["var.region"], route_table_ids: ref("aws_route_table.onprem", "id") } },
      { address: "aws_security_group.eice_onprem", values: tagged(c, { name: "lab-eice-onprem", description: "Instance Connect Endpoint in vpc-onprem: SSH out to vm-router", tags: { Name: "sg-eice-onprem" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.onprem", "id") } },
      rule("egress", "eice_onprem_ssh", "aws_security_group.eice_onprem", { cidr_ipv4: o, ip_protocol: "tcp", from_port: 22, to_port: 22 }, { cidr_ipv4: ["local.onprem_cidr"] }),
      { address: "aws_ec2_instance_connect_endpoint.onprem", values: tagged(c, { preserve_client_ip: false, tags: { Name: "eice-onprem" } }), unknown: ["subnet_id", "security_group_ids.0"], refs: { subnet_id: ref("aws_subnet.onprem", "id"), security_group_ids: ref("aws_security_group.eice_onprem", "id") } },
      // vpn.tf
      { address: "aws_vpn_gateway.lab", values: tagged(c, { amazon_side_asn: "64512", tags: { Name: "vgw-lab" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } },
      { address: "aws_vpn_gateway_route_propagation.private", values: {}, unknown: ["vpn_gateway_id", "route_table_id"], refs: { vpn_gateway_id: ref("aws_vpn_gateway.lab", "id"), route_table_id: ref("aws_route_table.private", "id") } },
      { address: "aws_customer_gateway.onprem", values: tagged(c, { bgp_asn: "65001", type: "ipsec.1", tags: { Name: "cgw-onprem" } }), unknown: ["ip_address"], refs: { ip_address: ref("aws_eip.router", "public_ip") } },
      { address: "random_password.psk1", values: { length: 32, special: false, numeric: false }, sensitive: ["bcrypt_hash", "result"] },
      { address: "random_password.psk2", values: { length: 32, special: false, numeric: false }, sensitive: ["bcrypt_hash", "result"] },
      {
        address: "aws_vpn_connection.lab",
        values: tagged(c, { type: "ipsec.1", static_routes_only: false, tunnel1_ike_versions: ["ikev2"], tunnel2_ike_versions: ["ikev2"], tags: { Name: "vpn-lab" } }),
        unknown: ["vpn_gateway_id", "customer_gateway_id", "tunnel1_preshared_key", "tunnel2_preshared_key"],
        sensitive: ["tunnel1_preshared_key", "tunnel2_preshared_key"],
        refs: {
          vpn_gateway_id: ref("aws_vpn_gateway.lab", "id"),
          customer_gateway_id: ref("aws_customer_gateway.onprem", "id"),
          tunnel1_preshared_key: ref("random_password.psk1", "result"),
          tunnel2_preshared_key: ref("random_password.psk2", "result"),
        },
      },
      // router.tf
      { address: "aws_eip.router", values: tagged(c, { domain: "vpc", tags: { Name: "eip-router" } }) },
      { address: "aws_eip_association.router", values: {}, unknown: ["network_interface_id", "allocation_id"], refs: { network_interface_id: ref("aws_network_interface.router", "id"), allocation_id: ref("aws_eip.router", "id") } },
      { address: "aws_security_group.router", values: tagged(c, { name: "lab-router", description: "vm-router: IKE and IPsec from the two AWS tunnel endpoints, SSH from eice-onprem", tags: { Name: "sg-router" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.onprem", "id") } },
      tunnelRule("router_ike_1", 1, 500),
      tunnelRule("router_ike_2", 2, 500),
      tunnelRule("router_natt_1", 1, 4500),
      tunnelRule("router_natt_2", 2, 4500),
      rule("ingress", "router_ssh_eice", "aws_security_group.router", { ip_protocol: "tcp", from_port: 22, to_port: 22 }, { referenced_security_group_id: ref("aws_security_group.eice_onprem", "id") }, ["referenced_security_group_id"]),
      rule("egress", "router_all", "aws_security_group.router", { cidr_ipv4: "0.0.0.0/0", ip_protocol: "-1" }),
      {
        address: "aws_network_interface.router",
        values: tagged(c, { private_ips: [routerIp], source_dest_check: false, tags: { Name: "nic-router" } }),
        unknown: ["subnet_id", "security_groups"],
        refs: { subnet_id: ref("aws_subnet.onprem", "id"), private_ips: ["local.router_ip"], security_groups: ref("aws_security_group.router", "id") },
      },
      router,
      // compute.tf
      { address: "aws_security_group.aws", values: tagged(c, { name: "lab-aws", description: "vm-aws: ping and HTTP from the on-prem VPC, through the VPN", tags: { Name: "sg-aws" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } },
      rule("ingress", "aws_icmp_onprem", "aws_security_group.aws", { cidr_ipv4: o, ip_protocol: "icmp", from_port: -1, to_port: -1 }, { cidr_ipv4: ["local.onprem_cidr"] }),
      rule("ingress", "aws_http_onprem", "aws_security_group.aws", { cidr_ipv4: o, ip_protocol: "tcp", from_port: 80, to_port: 80 }, { cidr_ipv4: ["local.onprem_cidr"] }),
      aws,
    ],
  };
};
