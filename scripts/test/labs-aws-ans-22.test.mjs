// labs-aws-ans-22.test.mjs
//
// Plain English: lab ans-22-s2s-vpn is the lab AWS labs spec §12.2 row 22
// describes: a virtual private gateway, a customer gateway and a VPN
// connection (two tunnels, BGP) to a pretend data centre whose Ubuntu
// router runs strongSwan and FRR behind an Elastic IP (ruling P11, §7.4).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "ans-22-s2s-vpn";
const of = (blocks, type) => blocks.filter((b) => b.kind === "resource" && b.labels[0] === type);
const body = (blocks, type, name) => of(blocks, type).find((b) => b.labels[1] === name)?.body ?? "";
const count = (text, re) => [...text.matchAll(re)].length;

test("ans-22 keeps the AWS lab contract; its one exception is ruling P11's Ubuntu router", () => {
  assert.deepEqual(commonAwsProblems(ID), [], "the Ubuntu router is accepted in PUBLIC_INSTANCE_LABS (Task 3's amiProblems)");
  const { blocks } = awsLab(ID);
  assert.match(blocks.find((b) => b.kind === "data" && b.labels[1] === "ubuntu_arm64").body, /name = "\/aws\/service\/canonical\/ubuntu\/server\/24\.04\/stable\/current\/arm64\/hvm\/ebs-gp3\/ami-id"/);
  assert.match(body(blocks, "aws_instance", "router"), /ami\s+= data\.aws_ssm_parameter\.ubuntu_arm64\.insecure_value/);
});

test("ans-22's lab.yaml: §12.2 row 22, after lab 20, about £0.05/h with the VPN connection billed by the whole hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["ANS-C01", "expert", "explore", ["ans.implementation", "ans.operations", "ans.design"], ["ans-20-vpc-design"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 12, destroy_min: 10, session_h: 2, max_h: 3 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 2 });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.micro", "t4g.nano"] });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.045 && total < 0.065, `about £0.054/h, got ${total}`);
  const vpn = yaml.cost.items.find((i) => i.name === "Site-to-site VPN connection, hourly");
  assert.deepEqual([vpn.whole_hours, vpn.aws_price.filters.usagetype], [true, "{usage}-VPN-Usage-Hours:ipsec.1"]);
});

test("ruling P11: VGW on 64512 propagating into rt-private, CGW on 65001 at the router's Elastic IP, two IKEv2 tunnels with BGP; nothing accelerated, private or logged", () => {
  const { blocks, files } = awsLab(ID);
  for (const re of [/vpc_id\s+= aws_vpc\.lab\.id/, /amazon_side_asn = 64512/]) assert.match(body(blocks, "aws_vpn_gateway", "lab"), re);
  assert.match(body(blocks, "aws_vpn_gateway_route_propagation", "private"), /route_table_id = aws_route_table\.private\.id/);
  for (const re of [/bgp_asn\s+= 65001/, /ip_address = aws_eip\.router\.public_ip/, /type\s+= "ipsec\.1"/]) assert.match(body(blocks, "aws_customer_gateway", "onprem"), re);
  const vpn = body(blocks, "aws_vpn_connection", "lab");
  for (const re of [/static_routes_only\s+= false/, /tunnel1_preshared_key = random_password\.psk1\.result/, /tunnel2_preshared_key = random_password\.psk2\.result/, /tunnel1_ike_versions\s+= \["ikev2"\]/, /tunnel2_ike_versions\s+= \["ikev2"\]/, /vpn_gateway_id\s+= aws_vpn_gateway\.lab\.id/]) assert.match(vpn, re);
  for (const re of [/enable_acceleration/, /outside_ip_address_type/, /transit_gateway_id/, /log_options/, /inside_cidr/]) assert.doesNotMatch(vpn, re);
  for (const k of ["psk1", "psk2"]) for (const re of [/length\s+= 32/, /special = false/, /numeric = false/]) assert.match(body(blocks, "random_password", k), re, k);
  assert.doesNotMatch(files["vpn.tf"], /"169\.254/, "AWS chooses the inside ranges (no literal CIDR)");
});

test("ruling P11 and §7.4: the router's Elastic IP admits only IKE and NAT-T from the two tunnel endpoints, and SSH only from eice-onprem", () => {
  const { blocks } = awsLab(ID);
  const rules = of(blocks, "aws_vpc_security_group_ingress_rule").filter((b) => b.body.includes("aws_security_group.router.id"));
  assert.equal(rules.length, 5);
  const fromTunnel = rules.filter((b) => /cidr_ipv4\s+= "\$\{aws_vpn_connection\.lab\.tunnel[12]_address\}\/32"/.test(b.body));
  assert.equal(fromTunnel.length, 4);
  for (const b of fromTunnel) assert.match(b.body, /ip_protocol\s+= "udp"\n\s+from_port\s+= (500|4500)\n\s+to_port\s+= \1/);
  assert.match(rules.find((b) => !fromTunnel.includes(b)).body, /referenced_security_group_id = aws_security_group\.eice_onprem\.id/);
  const router = body(blocks, "aws_instance", "router");
  for (const re of [/instance_type\s+= "t4g\.micro"/, /private_ip\s+= local\.router_ip/, /source_dest_check\s+= false/, /subnet_id\s+= aws_subnet\.onprem\.id/]) assert.match(router, re);
  assert.doesNotMatch(router, /associate_public_ip_address/);
  for (const re of [/instance_id\s+= aws_instance\.router\.id/, /allocation_id = aws_eip\.router\.id/]) assert.match(body(blocks, "aws_eip_association", "router"), re);
});

test("ans-22's router configures itself: sudo labadmin, strongSwan with the AWS-chosen inside addresses, FRR on 65001 advertising vpc-onprem, forwarding on", () => {
  const { blocks, files } = awsLab(ID);
  const r = files["router.tf"];
  for (const re of [/groups = \["sudo"\]/, /strongswan-swanctl charon-systemd frr/, /tunnel1_cgw_inside_address/, /tunnel1_vgw_inside_address/, /tunnel2_cgw_inside_address/, /tunnel2_vgw_inside_address/, /mode vti key \$\{t\.n \* 100\}/, /start_action = start/, /id = \$\{aws_eip\.router\.public_ip\}/, /router bgp \$\{aws_customer_gateway\.onprem\.bgp_asn\}/, /remote-as \$\{aws_vpn_gateway\.lab\.amazon_side_asn\}/, /network \$\{local\.onprem_cidr\}/, /net\.ipv4\.ip_forward = 1/, /install_routes = no/]) assert.match(r, re);
  assert.match(r, /chpasswd = \{ expire = false, users = \[\{ name = "labadmin"/, "the modern chpasswd form, not the deprecated list");
  assert.doesNotMatch(files["outputs.tf"], /psk|random_password|preshared/, "no pre-shared key in the outputs");
  assert.match(body(blocks, "aws_ec2_instance_connect_endpoint", "onprem"), /depends_on\s+= \[aws_instance\.router\]/);
  const onprem = files["onprem.tf"];
  for (const re of [/onprem_cidr\s+= cidrsubnet\(var\.address_space, 2, 1\)/, /router_ip\s+= cidrhost\(local\.onprem_subnet_cidr, 10\)/, /destination_cidr_block = local\.vpc_cidr\n\s+network_interface_id\s+= aws_instance\.router\.primary_network_interface_id/]) assert.match(onprem, re);
  assert.equal(count(onprem, /map_public_ip_on_launch = false/g), 1);
});

test("ans-22's readme reads the tunnels from both ends, fails one over, names what is not built, and its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["Tunnel details", "Propagated: Yes", "swanctl --list-sas", "show ip bgp summary", "swanctl --terminate --ike aws1", "Download configuration", "Direct Connect", "accelerated VPN"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
