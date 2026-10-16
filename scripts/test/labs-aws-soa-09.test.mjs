// labs-aws-soa-09.test.mjs
//
// Plain English: lab soa-09-route53-cloudfront is the lab AWS labs spec
// §12.2 row 09 describes: a zone named <name prefix>.labs.clydeford.net and
// never delegated (A27), weighted and failover records with one health check
// (P8), and CloudFront with origin access control to a private bucket, all on
// the default provider (P7).

import { test } from "node:test";
import assert from "node:assert/strict";
import { awsLab, commonAwsProblems } from "./fixtures/labs/aws-content.mjs";
import { resources } from "./fixtures/labs/content.mjs";
import { AWS_GLOBAL_LABS, validateLearning } from "../lib/labs.mjs";

const ID = "soa-09-route53-cloudfront";

test("soa-09 keeps the AWS lab contract and is a global lab with no third provider (ruling P7)", () => {
  assert.deepEqual(commonAwsProblems(ID), []);
  assert.ok(AWS_GLOBAL_LABS.includes(ID));
  const { tf } = awsLab(ID);
  assert.equal([...tf.matchAll(/provider "aws"/g)].length, 1);
  assert.doesNotMatch(tf, /us-east-1/);
});

test("soa-09's lab.yaml: §12.2 row 09", () => {
  const { yaml } = awsLab(ID);
  assert.deepEqual([yaml.exam, yaml.level, yaml.type, yaml.skill_areas, yaml.prerequisites], ["SOA-C03", "associate", "explore", ["soa.networking", "ans.design"], []]);
  assert.deepEqual(yaml.timing, { deploy_min: 8, destroy_min: 12, session_h: 2, max_h: 4 });
  assert.deepEqual(yaml.connectivity, { peering: "off", dns_link: false, subnets_used: 0 });
  assert.deepEqual(yaml.identity, { creates: [], roles: [], governance: false });
});

test("soa-09's zone, records and one health check (rulings A27, P8)", () => {
  const { lab, tf } = awsLab(ID);
  assert.match(tf, /zone = "\$\{var\.name_prefix\}\.labs\.clydeford\.net"/);
  assert.match(tf, /force_destroy = true\n\s+tags\s+= \{ Name = "zone-lab" \}/);
  assert.equal(resources(lab, "aws_route53_health_check").length, 1);
  assert.match(tf, /for_each\s+= \{ blue = 70, green = 30 \}/);
  for (const t of ["PRIMARY", "SECONDARY"]) assert.match(tf, new RegExp(`type = "${t}"`));
  assert.match(tf, /fqdn\s+= aws_cloudfront_distribution\.site\.domain_name/);
});

test("soa-09's distribution: OAC to a private bucket, PriceClass_100, an uncached /health.html", () => {
  const { tf } = awsLab(ID);
  for (const re of [/price_class\s+= "PriceClass_100"/, /retain_on_delete\s+= false/, /origin_access_control_id = aws_cloudfront_origin_access_control\.site\.id/, /path_pattern\s+= "\/health\.html"/, /cache_policy_id\s+= local\.caching_disabled/, /restrict_public_buckets = true/, /Principal = \{ Service = "cloudfront\.amazonaws\.com" \}/]) assert.match(tf, re);
});

test("soa-09's readme names what it builds", () => {
  const { readme } = awsLab(ID);
  for (const s of ["cdn-site", "hc-primary", "labs.clydeford.net", "weighted", "failover", "origin access control"]) assert.ok(readme.includes(s), s);
});

test("soa-09's learning content is valid", () => {
  const { learning, yaml } = awsLab(ID);
  assert.deepEqual(validateLearning(learning, yaml), []);
});
