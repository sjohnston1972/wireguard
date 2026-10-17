// labs-aws-ans-23.test.mjs
//
// Plain English: lab ans-23-hybrid-dns is the lab AWS labs spec §12.2 row 23
// describes: Route 53 Resolver inbound and outbound endpoints, a forwarding
// rule to an "on-prem" dnsmasq server, a private hosted zone, DNS Firewall and
// query logging to the lab's bucket (rulings P1, P7, P8, P12, P21).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { AWS_DNS_LABS, AWS_GLOBAL_LABS, validateLearning } from "../lib/labs.mjs";

const ID = "ans-23-hybrid-dns";
/** The body of resource `type`.`name` (or the first of `type`). */
const block = (type, name) => awsLab(ID).blocks.find((b) => b.kind === "resource" && b.labels[0] === type && (name === undefined || b.labels[1] === name))?.body ?? "";

test("ans-23 keeps the AWS lab contract and lists its private zone in us-east-1 (ruling P1)", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  assert.ok(AWS_DNS_LABS.includes(ID) && !AWS_GLOBAL_LABS.includes(ID));
  assert.deepEqual(awsLab(ID).yaml.regions, { secondary: null });
});

test("ans-23's lab.yaml: §12.2 row 23, about £0.38/h, four Resolver interfaces billed by the whole hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["ANS-C01", "expert", "explore", ["ans.design", "ans.implementation", "ans.security"], ["ans-20-vpc-design"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 8, destroy_min: 8, session_h: 2, max_h: 3 });
  assert.deepEqual(yaml.connectivity, { peering: "optional", dns_link: false, subnets_used: 2 });
  assert.deepEqual(yaml.identity, { creates: [], roles: [], governance: false });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.nano", "t4g.nano"] });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.36 && total < 0.4, `about £0.38/h, got ${total}`);
  const r = yaml.cost.items.find((i) => i.name.startsWith("Route 53 Resolver endpoint"));
  assert.deepEqual([r.gbp_h, r.qty, r.whole_hours], [0.0938, 4, true]);
});

test("ans-23's Resolver (ruling P12): two Do53 endpoints with AWS-chosen addresses in both private subnets, one FORWARD rule for the corp .internal name to dnsmasq", () => {
  const { files, tf } = awsLab(ID);
  for (const re of [
    /direction\s+= "INBOUND"/, /direction\s+= "OUTBOUND"/, /rule_type\s+= "FORWARD"/, /domain_name\s+= local\.corp_domain/,
    /corp_domain\s+= "corp\.\$\{var\.name_prefix\}\.internal"/, /cloud_domain = "cloud\.\$\{var\.name_prefix\}\.internal"/, /resolver_endpoint_id = aws_route53_resolver_endpoint\.outbound\.id/,
    /dns_ip\s+= cidrhost\(local\.onprem_subnet_cidr, 10\)/,
  ]) assert.match(tf, re);
  for (const dir of ["inbound", "outbound"]) {
    const b = block("aws_route53_resolver_endpoint", dir);
    assert.match(b, /ip_address \{\n\s+subnet_id = aws_subnet\.private\[0\]\.id\n\s+\}\n\s+ip_address \{\n\s+subnet_id = aws_subnet\.private\[1\]\.id\n\s+\}/, `${dir}: one address per private subnet, none fixed`);
    assert.doesNotMatch(b, /\bip\s+=/, `${dir}: AWS chooses the addresses`);
  }
  assert.doesNotMatch(tf, /inbound_ips|outbound_ips/);
  assert.equal([...files["resolver.tf"].matchAll(/protocols\s+= \["Do53"\]/g)].length, 2);
  assert.equal([...tf.matchAll(/resource "aws_route53_resolver_rule" /g)].length, 1);
  assert.match(block("aws_route53_resolver_rule", "corp"), /ip\s+= local\.dns_ip\n\s+port = 53/);
  assert.doesNotMatch(tf, /"(SYSTEM|RECURSIVE)"/);
});

test("ans-23's dnsmasq: on its own address, answers the corp name, forwards the cloud name to the inbound endpoint's addresses by reference", () => {
  const { files } = awsLab(ID);
  const c = files["compute.tf"];
  for (const s of [
    '"listen-address=${local.dns_ip}"', '"bind-interfaces"', '"no-resolv"', '"server=169.254.169.253"', '"local=/${local.corp_domain}/"', '"address=/app.${local.corp_domain}/${local.dns_ip}"',
    "inbound_addresses = sort([for a in aws_route53_resolver_endpoint.inbound.ip_address : a.ip])", '[for ip in local.inbound_addresses : "server=/${local.cloud_domain}/${ip}"]',
    "dnf install -y dnsmasq bind-utils", "--conf-file=/etc/lab-dnsmasq.conf",
  ]) assert.ok(c.includes(s), s);
  assert.match(block("aws_instance", "dns"), /private_ip\s+= local\.dns_ip/);
  assert.match(block("aws_ec2_instance_connect_endpoint", "onprem"), /depends_on\s+= \[aws_instance\.dns\]/, "the endpoint can never take dnsmasq's fixed address first");
});

test("ans-23's firewall, logs and waits (rulings P7, P8, P21): NXDOMAIN for example.com, logs to the lab's bucket for this account only, changes after 20 seconds", () => {
  const { tf } = awsLab(ID);
  for (const re of [/domains = \["example\.com\.", "\*\.example\.com\."\]/, /action\s+= "BLOCK"/, /block_response\s+= "NXDOMAIN"/, /mutation_protection\s+= "DISABLED"/, /destination_arn = aws_s3_bucket\.dnslogs\.arn/, /Principal = \{ Service = "delivery\.logs\.amazonaws\.com" \}/, /create_duration = "20s"/]) assert.match(tf, re);
  assert.equal([...block("aws_s3_bucket_policy", "dnslogs").matchAll(/"aws:SourceAccount" = data\.aws_caller_identity\.current\.account_id/g)].length, 2);
  for (const t of ["aws_route53_resolver_rule_association", "aws_route53_resolver_firewall_rule", "aws_route53_resolver_query_log_config_association"]) assert.match(block(t), /depends_on\s+= \[time_sleep\.resolver_tags\]/, t);
  for (const r of ["aws_route53_resolver_rule.corp", "aws_route53_resolver_firewall_domain_list.blocked", "aws_route53_resolver_firewall_rule_group.lab", "aws_route53_resolver_query_log_config.lab"]) assert.ok(block("time_sleep", "resolver_tags").includes(r), r);
  assert.doesNotMatch(tf, /aws_cloudwatch_log_group|cloud-watch-logs|arn:aws:logs:/, "ruling P8: no CloudWatch Logs destination");
});

test("ans-23's networks: the data centre in the slot's second /20, peered by the lab; a private .internal zone on vpc-lab", () => {
  const { tf } = awsLab(ID);
  for (const re of [/onprem_cidr\s+= cidrsubnet\(var\.address_space, 2, 1\)/, /auto_accept = true/, /name\s+= local\.cloud_domain/, /vpc_id\s+= aws_vpc\.lab\.id\n\s+vpc_region = var\.region/, /records = \[aws_instance\.cloud\.private_ip\]/]) assert.match(tf, re);
  assert.equal([...tf.matchAll(/resource "aws_ec2_instance_connect_endpoint"/g)].length, 2);
});

test("ans-23's readme walks both directions, the firewall and the logs, without promising fixed endpoint addresses; its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["rslvr-in", "rslvr-out", "dnsmasq", "NXDOMAIN", "vpcdnsquerylogs", "journalctl -u lab-dns"]) assert.ok(readme.includes(s), s);
  assert.doesNotMatch(readme, /\.10\b|\.11\b|host \.1/, "AWS chooses the endpoints' addresses");
  assert.deepEqual(validateLearning(learning, yaml), []);
});
