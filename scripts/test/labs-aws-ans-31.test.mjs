// labs-aws-ans-31.test.mjs
//
// Plain English: lab ans-31-client-vpn is the lab AWS labs spec §12.2 row 31
// describes: a Client VPN endpoint with mutual certificate authentication
// (CA, server and client from tls, imported to ACM), split tunnel, an
// authorisation rule and a target instance, with the client's files handed
// out through the sensitive files output (rulings A13, P2, P20).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { AWS_FILES_LABS, validateLearning } from "../lib/labs.mjs";

const ID = "ans-31-client-vpn";
const block = (type, name) => awsLab(ID).blocks.find((b) => b.kind === "resource" && b.labels[0] === type && (name === undefined || b.labels[1] === name))?.body ?? "";
const output = (name) => awsLab(ID).blocks.find((b) => b.kind === "output" && b.labels[0] === name)?.body ?? "";

test("ans-31 keeps the AWS lab contract and is the files lab (ruling P1)", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  assert.deepEqual(AWS_FILES_LABS, [ID]);
});

test("ans-31's lab.yaml: §12.2 row 31, no prerequisites, about £0.12/h with the association billed by the whole hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["ANS-C01", "expert", "explore", ["ans.implementation", "ans.security"], []]);
  assert.deepEqual(yaml.timing, { deploy_min: 10, destroy_min: 8, session_h: 2, max_h: 3 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 2 });
  assert.deepEqual(yaml.identity, { creates: [], roles: [], governance: false });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.1 && total < 0.13, `about £0.12/h, got ${total}`);
  const a = yaml.cost.items.find((i) => i.name.startsWith("Client VPN subnet association"));
  assert.deepEqual([a.gbp_h, a.whole_hours, a.aws_price], [0.075, true, undefined]);
});

test("ans-31's certificates (ruling P20): an RSA 2048 CA signing a server and a client certificate for 48 hours; one ACM import, used as server and root chain", () => {
  const { tf } = awsLab(ID);
  assert.equal([...tf.matchAll(/rsa_bits\s+= 2048/g)].length, 3);
  assert.equal([...tf.matchAll(/validity_period_hours = 48/g)].length, 3);
  for (const re of [/is_ca_certificate\s+= true/, /common_name\s+= "cloudlabs ans-31 CA"/, /allowed_uses\s+= \["server_auth", "digital_signature", "key_encipherment"\]/, /allowed_uses\s+= \["client_auth", "digital_signature"\]/]) assert.match(tf, re);
  const acm = block("aws_acm_certificate", "server");
  for (const re of [/private_key\s+= tls_private_key\.server\.private_key_pem/, /certificate_body\s+= tls_locally_signed_cert\.server\.cert_pem/, /certificate_chain = tls_self_signed_cert\.ca\.cert_pem/]) assert.match(acm, re);
  assert.doesNotMatch(tf, /domain_name|certificate_authority_arn|validation_method/, "import only (ruling P14)");
  assert.equal([...tf.matchAll(/resource "aws_acm_certificate"/g)].length, 1);
});

test("ans-31's endpoint (ruling P20): certificates only, the client /22 in the slot, split tunnel, no logs or portal, one association, one rule to vpc-lab", () => {
  const { tf } = awsLab(ID);
  const e = block("aws_ec2_client_vpn_endpoint", "lab");
  for (const re of [/server_certificate_arn = aws_acm_certificate\.server\.arn/, /client_cidr_block\s+= local\.client_cidr/, /split_tunnel\s+= true/, /transport_protocol\s+= "udp"/, /vpn_port\s+= 443/, /self_service_portal\s+= "disabled"/, /type\s+= "certificate-authentication"/, /root_certificate_chain_arn = aws_acm_certificate\.server\.arn/, /connection_log_options \{\n\s+enabled = false/]) assert.match(e, re);
  assert.match(tf, /client_cidr = cidrsubnet\(var\.address_space, 4, 15\)/);
  assert.equal([...tf.matchAll(/resource "aws_ec2_client_vpn_network_association"/g)].length, 1);
  assert.match(block("aws_ec2_client_vpn_authorization_rule", "lab"), /target_network_cidr\s+= local\.vpc_cidr/);
  assert.doesNotMatch(tf, /directory-service-authentication|federated-authentication|aws_ec2_client_vpn_route|cloudwatch_log_group/);
});

test("ans-31's files output (rulings A13, P2): sensitive, three files, a complete OpenVPN profile", () => {
  const o = output("files");
  assert.match(o, /^\s*sensitive = true$/m);
  for (const k of ['"ans-31.ovpn" = local.ovpn', '"client.crt"  = tls_locally_signed_cert.client.cert_pem', '"client.key"  = tls_private_key.client.private_key_pem']) assert.ok(o.includes(k), k);
  const { files } = awsLab(ID);
  for (const s of ['"client"', '"dev tun"', '"proto udp"', '"remote ${replace(aws_ec2_client_vpn_endpoint.lab.dns_name, "*.", "")} 443"', '"remote-random-hostname"', '"remote-cert-tls server"', '"cipher AES-256-GCM"', '"reneg-sec 0"', '"<ca>"', '"<cert>"', '"<key>"', "trimspace(tls_private_key.client.private_key_pem)"]) assert.ok(files["outputs.tf"].includes(s), s);
  assert.doesNotMatch(output("connect") + output("private_ips"), /private_key|cert_pem/, "no key or certificate outside the files output");
});

test("ans-31's target admits SSH, HTTP and ping from the VPN's security group", () => {
  const { tf } = awsLab(ID);
  assert.equal([...tf.matchAll(/referenced_security_group_id = aws_security_group\.cvpn\.id/g)].length, 3);
  assert.match(block("aws_vpc_security_group_egress_rule", "cvpn_to_lab"), /cidr_ipv4\s+= local\.vpc_cidr/);
});

test("ans-31's readme connects, compares with WireGuard and names Verified Access as not built; its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["ans-31.ovpn", "**Show**", "WireGuard", "AllowedIPs", "split tunnel", "## Not built here", "Verified Access"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
