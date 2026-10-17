// labs-aws-ans-25.test.mjs
//
// Plain English: lab ans-25-load-balancing is the lab AWS labs spec §12.2
// row 25 describes: an ALB with weighted target groups and a path rule on an
// imported self-signed certificate, an NLB on a static Elastic IP with TLS and
// proxy protocol, and a Gateway Load Balancer with a GENEVE appliance that
// inspects one subnet's internet traffic (rulings P13, P14).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { resources } from "./fixtures/labs/content.mjs";
import { validateLearning } from "../lib/labs.mjs";

const ID = "ans-25-load-balancing";
const block = (lab, type, name) => resources(lab, type).find((r) => r.labels[1] === name)?.body ?? "";

test("ans-25 keeps the AWS lab contract", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
});

test("ans-25's lab.yaml: §12.2 row 25, after soa-03, one /20, about £0.15/h with the load balancers, the GWLB endpoint and NAT billed by the whole hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["ANS-C01", "expert", "explore", ["ans.design", "ans.security"], ["soa-03-auto-scaling"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 10, destroy_min: 8, session_h: 2, max_h: 3 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 1 });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.small", "t4g.nano", "t4g.nano", "t4g.nano"] });
  assert.deepEqual(yaml.regions, { secondary: null });
  assert.deepEqual(yaml.identity, { creates: [], roles: [], governance: false });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.13 && total < 0.17, `about £0.15/h, got ${total}`);
  for (const n of ["Application Load Balancer, hourly", "Network Load Balancer, hourly", "Gateway Load Balancer, hourly", "Gateway Load Balancer endpoint, one AZ", "NAT gateway, hourly"]) assert.equal(yaml.cost.items.find((i) => i.name === n).whole_hours, true, n);
  assert.equal(yaml.cost.items.find((i) => i.name.startsWith("Public IPv4")).qty, 4);
});

test("ruling P14: the certificate is imported from the lab's own tls resources, RSA 2048, valid a week", () => {
  const { lab, tf } = awsLab(ID);
  const cert = block(lab, "aws_acm_certificate", "app");
  for (const re of [/private_key\s+= tls_private_key\.server\.private_key_pem/, /certificate_body\s+= tls_locally_signed_cert\.server\.cert_pem/, /certificate_chain = tls_self_signed_cert\.ca\.cert_pem/]) assert.match(cert, re);
  assert.doesNotMatch(cert, /domain_name|validation_method|certificate_authority_arn/);
  assert.equal([...tf.matchAll(/rsa_bits\s+= 2048/g)].length, 2);
  assert.equal([...tf.matchAll(/validity_period_hours = 168/g)].length, 2);
  assert.match(tf, /dns_names\s+= \["app\.\$\{var\.name_prefix\}\.internal"\]/);
});

test("the ALB: HTTP redirects, HTTPS on the imported certificate forwards blue 80 / green 20, /green/* goes to green", () => {
  const { lab } = awsLab(ID);
  assert.match(block(lab, "aws_lb", "alb"), /internal\s+= false/);
  const http = block(lab, "aws_lb_listener", "http");
  for (const re of [/type = "redirect"/, /protocol\s+= "HTTPS"/, /status_code = "HTTP_301"/]) assert.match(http, re);
  const https = block(lab, "aws_lb_listener", "https");
  for (const re of [/certificate_arn\s+= aws_acm_certificate\.app\.arn/, /ssl_policy\s+= "ELBSecurityPolicy-TLS13-1-2-2021-06"/, /arn\s+= aws_lb_target_group\.blue\.arn\n\s+weight = 80/, /arn\s+= aws_lb_target_group\.green\.arn\n\s+weight = 20/]) assert.match(https, re);
  const rule = block(lab, "aws_lb_listener_rule", "green");
  for (const re of [/priority\s+= 10/, /values = \["\/green\/\*"\]/, /target_group_arn = aws_lb_target_group\.green\.arn/]) assert.match(rule, re);
});

test("the NLB: one Elastic IP subnet mapping, its own security group, TLS 443 on the same certificate, TCP 8080 to a proxy protocol v2 group", () => {
  const { lab } = awsLab(ID);
  const nlb = block(lab, "aws_lb", "nlb");
  for (const re of [/load_balancer_type\s+= "network"/, /security_groups\s+= \[aws_security_group\.nlb\.id\]/, /allocation_id = aws_eip\.nlb\.id/]) assert.match(nlb, re);
  assert.match(block(lab, "aws_lb_listener", "tls"), /protocol\s+= "TLS"[\s\S]*certificate_arn\s+= aws_acm_certificate\.app\.arn/);
  assert.match(block(lab, "aws_lb_listener", "pp"), /port\s+= 8080/);
  assert.match(block(lab, "aws_lb_target_group", "pp"), /proxy_protocol_v2 = true/);
  assert.match(block(lab, "aws_vpc_security_group_ingress_rule", "web_from_nlb"), /referenced_security_group_id = aws_security_group\.nlb\.id/);
});

test("ruling P13: the GWLB's endpoint service is this account's only, its endpoint is the inspected subnet's next hop both ways, the appliance a t4g.small with no public address", () => {
  const { lab, tf } = awsLab(ID);
  assert.match(block(lab, "aws_lb", "gwlb"), /load_balancer_type\s+= "gateway"/);
  assert.match(block(lab, "aws_lb_target_group", "gwlb"), /port\s+= 6081\n\s+protocol\s+= "GENEVE"/);
  const svc = block(lab, "aws_vpc_endpoint_service", "gwlb");
  for (const re of [/acceptance_required\s+= false/, /gateway_load_balancer_arns = \[aws_lb\.gwlb\.arn\]/, /allowed_principals\s+= \["arn:aws:iam::\$\{data\.aws_caller_identity\.current\.account_id\}:root"\]/]) assert.match(svc, re);
  assert.doesNotMatch(svc, /private_dns_name|supported_regions/);
  assert.match(block(lab, "aws_vpc_endpoint", "gwlb"), /service_name\s+= aws_vpc_endpoint_service\.gwlb\.service_name\n\s+vpc_endpoint_type = "GatewayLoadBalancer"/);
  for (const r of ["public_inspected", "inspected_gwlbe"]) assert.match(block(lab, "aws_route", r), /vpc_endpoint_id\s+= aws_vpc_endpoint\.gwlb\.id/, r);
  assert.match(block(lab, "aws_route", "public_inspected"), /destination_cidr_block = local\.inspected_cidr/);
  const app = block(lab, "aws_instance", "appliance");
  assert.match(app, /instance_type\s+= "t4g\.small"/);
  assert.doesNotMatch(tf, /associate_public_ip_address|aws_eip_association/);
  assert.match(tf, /aws-gateway-load-balancer-tunnel-handler/);
  assert.equal([...tf.matchAll(/resource "aws_nat_gateway"/g)].length, 1);
});

test("ans-25's readme names each load balancer's trick and its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["alb-app", "nlb-app", "gwlb-appliance", "vpces-gwlb", "eip-nlb", "/green/", "proxy protocol", "gwlbtun", "cert-app"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
