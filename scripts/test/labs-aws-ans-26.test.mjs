// labs-aws-ans-26.test.mjs
//
// Plain English: lab ans-26-edge is the lab AWS labs spec §12.2 row 26
// describes, the only four-region lab: CloudFront with an origin group, a
// CloudFront Function and a WAF web ACL (us-east-1), and Global Accelerator
// (us-west-2) to Network Load Balancers in London and Ireland, never to
// instances (rulings P1, P9, P10).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { resources } from "./fixtures/labs/content.mjs";
import { AWS_GA_LABS, AWS_GLOBAL_LABS, AWS_PEER_REGION_LABS, readsUsWest2, validateLearning } from "../lib/labs.mjs";

const ID = "ans-26-edge";
const block = (lab, type, name) => resources(lab, type).find((r) => r.labels[1] === name)?.body ?? "";

test("ans-26 keeps the AWS lab contract; it is a global and Global Accelerator lab with Ireland as its secondary region", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  const { yaml } = awsLab(ID);
  assert.deepEqual(yaml.regions, { secondary: "eu-west-1" });
  assert.ok(AWS_GLOBAL_LABS.includes(ID) && AWS_GA_LABS.includes(ID) && readsUsWest2(ID));
  assert.ok(!AWS_PEER_REGION_LABS.includes(ID));
});

test("ans-26's lab.yaml: §12.2 row 26, after soa-09, never peered, two /20s, about £0.08/h with the fixed fee and NLBs billed by the whole hour", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["ANS-C01", "expert", "explore", ["ans.design", "ans.security", "soa.networking"], ["soa-09-route53-cloudfront"]]);
  assert.deepEqual(yaml.timing, { deploy_min: 12, destroy_min: 15, session_h: 2, max_h: 3 });
  assert.deepEqual(yaml.connectivity, { peering: "off", dns_link: false, subnets_used: 2 });
  assert.deepEqual(yaml.capacity, { instance_types: ["t4g.nano", "t4g.nano"] });
  assert.deepEqual(yaml.identity, { creates: [], roles: [], governance: false });
  const total = yaml.cost.items.reduce((n, i) => n + i.gbp_h * (i.qty ?? 1), 0);
  assert.ok(total > 0.07 && total < 0.095, `about £0.08/h, got ${total}`);
  for (const n of ["Global Accelerator fixed fee ($0.025 an hour)", "Network Load Balancer, London, hourly", "Network Load Balancer, Ireland, hourly"]) assert.equal(yaml.cost.items.find((i) => i.name === n).whole_hours, true, n);
  assert.equal(yaml.cost.items.filter((i) => i.region === "secondary").length, 4);
});

test("ruling P9: two provider blocks only (§4's default and secondary); the ACL's own region is us-east-1; no region written as us-west-2", () => {
  const { files, tf, lab } = awsLab(ID);
  assert.equal([...tf.matchAll(/^provider "aws" \{/gm)].length, 2);
  assert.match(files["ireland.tf"], /provider "aws" \{\n  alias  = "secondary"\n  region = var\.secondary_region\n  default_tags \{\n    tags = var\.tags\n  \}\n\}/);
  const waf = block(lab, "aws_wafv2_web_acl", "lab");
  for (const re of [/region\s+= "us-east-1"/, /scope\s+= "CLOUDFRONT"/, /name\s+= "lab-\$\{var\.lab_id\}-waf"/]) assert.match(waf, re);
  assert.doesNotMatch(tf, /"us-west-2"/, "Global Accelerator goes through the default provider");
  assert.equal([...tf.matchAll(/region\s+= "us-east-1"/g)].length, 1, "only the web ACL names us-east-1");
});

test("ruling P9: Global Accelerator fronts the two lab NLBs, never instances, with client IP preservation off and flow logs off", () => {
  const { lab, tf } = awsLab(ID);
  assert.match(block(lab, "aws_globalaccelerator_accelerator", "lab"), /flow_logs_enabled = false/);
  const groups = { london: ["var.region", "aws_lb.london.arn"], ireland: ["var.secondary_region", "aws_lb.ireland.arn"] };
  for (const [g, [region, lb]] of Object.entries(groups)) {
    const body = block(lab, "aws_globalaccelerator_endpoint_group", g);
    assert.match(body, new RegExp(`endpoint_group_region\\s+= ${region.replace(".", "\\.")}\\n`), g);
    assert.match(body, new RegExp(`endpoint_id\\s+= ${lb.replace(/\./g, "\\.")}\\n`), g);
    assert.match(body, /client_ip_preservation_enabled = false/, g);
  }
  assert.doesNotMatch(tf, /endpoint_id\s+= aws_instance\./);
  for (const lb of ["london", "ireland"]) {
    const body = block(lab, "aws_lb", lb);
    assert.match(body, /load_balancer_type\s+= "network"/);
    assert.match(body, /internal\s+= false/);
    assert.doesNotMatch(body, /security_groups/, `${lb}: no security group (P9)`);
  }
  assert.doesNotMatch(tf, /associate_public_ip_address|aws_eip"/);
});

test("CloudFront: an origin group London then Ireland on 500/502/503/504, the lab's function on viewer requests, the lab's ACL, PriceClass_100", () => {
  const { lab } = awsLab(ID);
  const cdn = block(lab, "aws_cloudfront_distribution", "lab");
  for (const re of [/price_class\s+= "PriceClass_100"/, /retain_on_delete\s+= false/, /web_acl_id\s+= aws_wafv2_web_acl\.lab\.arn/, /domain_name\s+= aws_lb\.london\.dns_name/, /domain_name = aws_lb\.ireland\.dns_name/, /status_codes = \[500, 502, 503, 504\]/, /target_origin_id\s+= "failover"/, /event_type\s+= "viewer-request"\n\s+function_arn = aws_cloudfront_function\.headers\.arn/, /cache_policy_id\s+= local\.caching_disabled/, /origin_request_policy_id\s+= local\.all_viewer_except_host/]) assert.match(cdn, re);
  assert.doesNotMatch(cdn, /lambda_function_association|logging_config/);
  const fn = block(lab, "aws_cloudfront_function", "headers");
  for (const re of [/name\s+= "lab-\$\{var\.lab_id\}-headers"/, /runtime = "cloudfront-js-2\.0"/, /publish = true/, /x-cloudlabs-edge/]) assert.match(fn, re);
});

test("ruling P9: the web ACL holds AWS's Core rule set and one rate rule, no paid group", () => {
  const { lab } = awsLab(ID);
  const waf = block(lab, "aws_wafv2_web_acl", "lab");
  assert.equal([...waf.matchAll(/^\s+rule \{/gm)].length, 2);
  for (const re of [/name\s+= "AWSManagedRulesCommonRuleSet"\n\s+vendor_name = "AWS"/, /limit\s+= 100/, /aggregate_key_type\s+= "IP"/]) assert.match(waf, re);
  assert.doesNotMatch(waf, /BotControl|ATP|ACFP|AntiDDoS/);
});

test("ans-26's Ireland: its own resource group and VPC in the slot's second /20, the instance on the Ireland AMI parameter", () => {
  const { lab, tf } = awsLab(ID);
  for (const re of [/resource "aws_resourcegroups_group" "secondary" \{\n  provider = aws\.secondary/, /ireland_vpc_cidr\s+= cidrsubnet\(var\.address_space, 2, 1\)/]) assert.match(tf, re);
  const vm = block(lab, "aws_instance", "ireland");
  assert.match(vm, /provider\s+= aws\.secondary\n\s+ami\s+= data\.aws_ssm_parameter\.al2023_ireland\.insecure_value/);
  assert.deepEqual(resources(lab, "aws_ec2_instance_connect_endpoint").map((r) => r.labels[1]).sort(), ["ireland", "lab"], "two Instance Connect Endpoints, one per region");
});

test("ans-26's readme names every edge piece and Shield Advanced as not built; its learning content is valid", () => {
  const { readme, learning, yaml } = awsLab(ID);
  for (const s of ["lab-ans-26-edge-waf", "lab-ans-26-edge-headers", "x-cloudlabs-edge", "traffic dial", "origin group", "us-west-2", "## Not built here", "Shield Advanced"]) assert.ok(readme.includes(s), s);
  assert.deepEqual(validateLearning(learning, yaml), []);
});

test("the WAF web ACL's description (and every name and description it writes) uses only characters AWS accepts: no apostrophe (release test 39031657786)", () => {
  const { files } = awsLab(ID);
  for (const [file, text] of Object.entries(files)) {
    if (file === "variables.tf" || !file.endsWith(".tf")) continue;
    for (const m of text.matchAll(/^\s*(description|name|metric_name)\s*=\s*"([^"\n]*)"/gm)) {
      assert.doesNotMatch(m[2].replace(/\$\{[^}]*\}/g, ""), /[^A-Za-z0-9 ._:\/()#,@\[\]+=&;{}!$*-]/, `${file}: ${m[1]} = "${m[2]}"`);
    }
  }
});
