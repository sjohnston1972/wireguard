// scripts/test/fixtures/labs/plans/labs/soa-09-route53-cloudfront.mjs
//
// Plain English: lab soa-09's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the
// template's resource group, then site.tf (the private bucket, its public
// access block, the CloudFront-only policy and two objects), cdn.tf (the
// origin access control and the distribution) and dns.tf (the zone, the
// health check and the records). The lab has no network.tf (ruling P3), so no
// zones and no AMI are read. Names built from var.lab_id and var.name_prefix
// are known at plan, so are the zone's name, the bucket policy and the
// distribution's settings; ids, ARNs, the distribution's domain name and
// hosted zone id and the zone's id and name servers are unknown. The origin's
// domain name and access control id are unknown inside the origin block. The
// global types carry no region (computed.json).

import { AWS_PROVIDER_CONFIG, ACCOUNT, ctxAws, ref, tagged, templateMainData, templateMainResources } from "../common-aws.mjs";

export default () => {
  const c = ctxAws("soa-09-route53-cloudfront", "09");
  const id = c.id;
  const bucket = `cloudlabs-${c.prefix}-site`;
  const zone = `${c.prefix}.labs.clydeford.net`;
  const dist = "aws_cloudfront_distribution.site";
  const zoneRef = ref("aws_route53_zone.lab", "zone_id");
  const onBucket = (type, key, values, extra = {}) => ({
    address: `${type}.${key}`,
    values,
    unknown: ["bucket", ...(extra.unknown ?? [])],
    refs: { bucket: ref("aws_s3_bucket.site", "id"), ...(extra.refs ?? {}) },
  });
  const object = (key, file, content, type) => onBucket("aws_s3_object", key, tagged(c, { key: file, content, content_type: type }), { refs: { content: ["var.lab_id"] } });
  const release = (key) => ({
    address: `aws_route53_record.release["${key}"]`,
    forEach: { references: [], constant_value: ["blue", "green", "sorry"] },
    values: { name: `${key}.${zone}`, type: "CNAME", ttl: 60 },
    unknown: ["zone_id", "records"],
    refs: { zone_id: zoneRef, name: ["each.key", "local.zone"], records: ["local.cdn", ...ref(dist, "domain_name")] },
  });
  const app = (key, weight) => ({
    address: `aws_route53_record.app["${key}"]`,
    forEach: { references: [], constant_value: { blue: 70, green: 30 } },
    values: { name: `app.${zone}`, type: "CNAME", ttl: 60, set_identifier: key, records: [`${key}.${zone}`], weighted_routing_policy: [{ weight }] },
    unknown: ["zone_id"],
    refs: { zone_id: zoneRef, name: ["local.zone"], set_identifier: ["each.key"], records: ["each.key", "local.zone"], "weighted_routing_policy.0.weight": ["each.value"] },
  });
  const failover = (key, label, type, target, extra = {}) => ({
    address: `aws_route53_record.${key}`,
    values: { name: `www.${zone}`, type: "CNAME", ttl: 60, set_identifier: label, records: [`${target}.${zone}`], failover_routing_policy: [{ type }] },
    unknown: ["zone_id", ...(extra.unknown ?? [])],
    refs: { zone_id: zoneRef, name: ["local.zone"], records: ["local.zone"], ...(extra.refs ?? {}) },
  });
  return {
    lab: id,
    variables: c.variables,
    providers: ["aws"],
    providerConfig: AWS_PROVIDER_CONFIG,
    data: templateMainData(),
    resources: [
      ...templateMainResources(c),
      // site.tf
      { address: "aws_s3_bucket.site", values: tagged(c, { bucket, force_destroy: true, tags: { Name: "site" } }), refs: { bucket: ["local.bucket"] } },
      onBucket("aws_s3_bucket_public_access_block", "site", { block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true }),
      onBucket("aws_s3_bucket_policy", "site", {
        policy: JSON.stringify({
          Statement: [{
            Action: "s3:GetObject",
            Condition: { ArnLike: { "AWS:SourceArn": `arn:aws:cloudfront::${ACCOUNT}:distribution/*` } },
            Effect: "Allow",
            Principal: { Service: "cloudfront.amazonaws.com" },
            Resource: `arn:aws:s3:::${bucket}/*`,
            Sid: "CloudFrontReadsThroughOriginAccessControl",
          }],
          Version: "2012-10-17",
        }),
      }, { refs: { policy: ["local.bucket_arn", "data.aws_caller_identity.current.account_id", "data.aws_caller_identity.current"] } }),
      object("index", "index.html", `<!doctype html><title>lab ${id}</title><h1>Served by CloudFront from a private bucket</h1>\n`, "text/html"),
      object("health", "health.html", "ok\n", "text/plain"),
      // cdn.tf
      {
        address: "aws_cloudfront_origin_access_control.site",
        values: { name: `lab-${id}-${c.prefix}`, description: `lab ${id}, CloudFront signs its requests to the site bucket`, origin_access_control_origin_type: "s3", signing_behavior: "always", signing_protocol: "sigv4" },
        refs: { name: ["var.lab_id", "var.name_prefix"], description: ["var.lab_id"] },
      },
      {
        address: dist,
        values: tagged(c, {
          enabled: true, comment: `lab ${id}`, default_root_object: "index.html", price_class: "PriceClass_100", retain_on_delete: false, wait_for_deployment: true,
          origin: [{ origin_id: "site" }],
          default_cache_behavior: [{ target_origin_id: "site", viewer_protocol_policy: "redirect-to-https", allowed_methods: ["GET", "HEAD"], cached_methods: ["GET", "HEAD"], cache_policy_id: "658327ea-f89d-4fab-a63d-7e88639e58f6", compress: true }],
          ordered_cache_behavior: [{ path_pattern: "/health.html", target_origin_id: "site", viewer_protocol_policy: "allow-all", allowed_methods: ["GET", "HEAD"], cached_methods: ["GET", "HEAD"], cache_policy_id: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" }],
          restrictions: [{ geo_restriction: [{ restriction_type: "none" }] }],
          viewer_certificate: [{ cloudfront_default_certificate: true }],
          tags: { Name: "cdn-site" },
        }),
        unknown: ["origin.0.domain_name", "origin.0.origin_access_control_id"],
        refs: {
          comment: ["var.lab_id"],
          "origin.0.domain_name": ref("aws_s3_bucket.site", "bucket_regional_domain_name"),
          "origin.0.origin_access_control_id": ref("aws_cloudfront_origin_access_control.site", "id"),
          "default_cache_behavior.0.cache_policy_id": ["local.caching_optimized"],
          "ordered_cache_behavior.0.cache_policy_id": ["local.caching_disabled"],
        },
      },
      // dns.tf
      { address: "aws_route53_zone.lab", values: tagged(c, { name: zone, comment: `lab ${id}, not delegated, ask its own name servers`, force_destroy: true, tags: { Name: "zone-lab" } }), refs: { name: ["local.zone"], comment: ["var.lab_id"] } },
      {
        address: "aws_route53_health_check.primary",
        values: tagged(c, { type: "HTTP", port: 80, resource_path: "/health.html", request_interval: 30, failure_threshold: 3, measure_latency: false, tags: { Name: "hc-primary" } }),
        unknown: ["fqdn"],
        refs: { fqdn: ref(dist, "domain_name") },
      },
      release("blue"),
      release("green"),
      release("sorry"),
      app("blue", 70),
      app("green", 30),
      failover("www_primary", "primary", "PRIMARY", "blue", { unknown: ["health_check_id"], refs: { health_check_id: ref("aws_route53_health_check.primary", "id") } }),
      failover("www_secondary", "secondary", "SECONDARY", "sorry"),
      {
        address: "aws_route53_record.cdn",
        values: { name: `cdn.${zone}`, type: "A", alias: [{ evaluate_target_health: false }] },
        unknown: ["zone_id", "alias.0.name", "alias.0.zone_id"],
        refs: { zone_id: zoneRef, name: ["local.zone"], "alias.0.name": ref(dist, "domain_name"), "alias.0.zone_id": ref(dist, "hosted_zone_id") },
      },
    ],
  };
};
