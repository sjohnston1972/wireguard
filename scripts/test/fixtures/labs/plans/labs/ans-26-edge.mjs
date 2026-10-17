// scripts/test/fixtures/labs/plans/labs/ans-26-edge.mjs
//
// Plain English: lab ans-26's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the template
// network, then london.tf (the public subnet, gateway, route, security group,
// vm-london and its NLB), ireland.tf (the secondary provider's resource group,
// VPC, subnets, gateway, routes, S3 endpoint, Instance Connect Endpoint,
// security groups, vm-ireland and its NLB, every one under aws.secondary and so
// planned in eu-west-1), accelerator.tf (Global Accelerator, signed by the
// default provider), cdn.tf (the CloudFront Function and distribution) and
// waf.tf (the CLOUDFRONT web ACL, whose own region is us-east-1). Names built
// from var.lab_id and var.name_prefix are known at plan; ids, ARNs and DNS
// names are not.

import { AWS_PROVIDER_CONFIG, AWS_SECONDARY, al2023Instance, awsData, cidrsubnet, ctxAws, ref, tagged, templateResources } from "../common-aws.mjs";

/** The secondary provider as ireland.tf configures it (ruling P5; the same as saa-16's fixture). */
const SECONDARY_PROVIDER_CONFIG = {
  "aws.secondary": { name: "aws", full_name: "registry.terraform.io/hashicorp/aws", alias: "secondary", expressions: { alias: { constant_value: "secondary" }, region: { references: ["var.secondary_region"] }, default_tags: [{ tags: { references: ["var.tags"] } }] } },
};

export default () => {
  const c = ctxAws("ans-26-edge", "26");
  const id = c.id;
  const p = c.prefix;
  const IE = "aws.secondary";
  const ieVpcCidr = cidrsubnet(c.address, 2, 1);
  const iePrivate = cidrsubnet(ieVpcCidr, 4, 0);
  const iePublic = cidrsubnet(ieVpcCidr, 4, 1);
  const IE_VPC = "aws_vpc.ireland";
  const VPC = "aws_vpc.lab";
  // A resource under the secondary provider (providerKey) or the default one.
  const on = (providerKey, r) => (providerKey ? { ...r, providerKey } : r);
  const rule = (kind, key, sgAddr, values, refs = {}, unknown = [], providerKey) =>
    on(providerKey, { address: `aws_vpc_security_group_${kind}_rule.${key}`, values: tagged(c, values), unknown: ["security_group_id", ...unknown], refs: { security_group_id: ref(sgAddr, "id"), ...refs } });
  const sg = (key, name, description, tagName, vpc, providerKey) =>
    on(providerKey, { address: `aws_security_group.${key}`, values: tagged(c, { name, description, tags: { Name: tagName } }), unknown: ["vpc_id"], refs: { vpc_id: ref(vpc, "id") } });
  const vpcOnly = (address, name, vpc, providerKey) => on(providerKey, { address, values: tagged(c, { tags: { Name: name } }), unknown: ["vpc_id"], refs: { vpc_id: ref(vpc, "id") } });
  const assoc = (key, subnetAddr, table, providerKey) =>
    on(providerKey, { address: `aws_route_table_association.${key}`, values: {}, unknown: ["subnet_id", "route_table_id"], refs: { subnet_id: ref(subnetAddr, "id"), route_table_id: ref(table, "id") } });
  const nlb = (key, suffix, subnetAddr, tagName, providerKey) =>
    on(providerKey, {
      address: `aws_lb.${key}`,
      values: tagged(c, { name: `nlb-${p}-${suffix}`, internal: false, load_balancer_type: "network", enable_deletion_protection: false, tags: { Name: tagName } }),
      unknown: ["subnets"],
      refs: { name: ["var.name_prefix"], subnets: ref(subnetAddr, "id") },
    });
  const tg = (key, suffix, vpc, tagName, providerKey) =>
    on(providerKey, { address: `aws_lb_target_group.${key}`, values: tagged(c, { name: `tg-${p}-${suffix}`, port: 80, protocol: "TCP", tags: { Name: tagName } }), unknown: ["vpc_id"], refs: { name: ["var.name_prefix"], vpc_id: ref(vpc, "id") } });
  const attach = (key, instance, providerKey) =>
    on(providerKey, { address: `aws_lb_target_group_attachment.${key}`, values: { port: 80 }, unknown: ["target_group_arn", "target_id"], refs: { target_group_arn: ref(`aws_lb_target_group.${key}`, "arn"), target_id: ref(instance, "id") } });
  const listener = (key, tagName, providerKey) =>
    on(providerKey, {
      address: `aws_lb_listener.${key}`,
      values: tagged(c, { port: 80, protocol: "TCP", default_action: [{ type: "forward" }], tags: { Name: tagName } }),
      unknown: ["load_balancer_arn", "default_action.0.target_group_arn"],
      refs: { load_balancer_arn: ref(`aws_lb.${key}`, "arn"), "default_action.0.target_group_arn": ref(`aws_lb_target_group.${key}`, "arn") },
    });
  const group = (key, region, regionRef, lb) => ({
    address: `aws_globalaccelerator_endpoint_group.${key}`,
    values: { endpoint_group_region: region, health_check_protocol: "TCP", health_check_port: 80, traffic_dial_percentage: 100, endpoint_configuration: [{ weight: 100, client_ip_preservation_enabled: false }] },
    unknown: ["listener_arn", "endpoint_configuration.0.endpoint_id"],
    refs: { listener_arn: ref("aws_globalaccelerator_listener.http", "arn"), endpoint_group_region: [regionRef], "endpoint_configuration.0.endpoint_id": ref(lb, "arn") },
  });
  const customOrigin = [{ http_port: 80, https_port: 443, origin_protocol_policy: "http-only", origin_ssl_protocols: ["TLSv1.2"] }];
  const visibility = (metric) => ({ cloudwatch_metrics_enabled: true, metric_name: metric, sampled_requests_enabled: true });

  const london = al2023Instance(c, { key: "london", name: "vm-london", type: "t4g.nano", sgs: ["aws_security_group.web"] });
  london.refs.user_data = ["local.london_cloud_init"];
  const ireland = al2023Instance(c, { key: "ireland", name: "vm-ireland", type: "t4g.nano", subnet: "aws_subnet.ireland_private", sgs: ["aws_security_group.ireland_web"] });
  ireland.providerKey = IE;
  ireland.values.ami = "ami-0fedcba9876543210";
  ireland.refs.ami = ["data.aws_ssm_parameter.al2023_ireland.insecure_value", "data.aws_ssm_parameter.al2023_ireland"];
  ireland.refs.user_data = ["local.ireland_cloud_init"];

  return {
    lab: id,
    variables: { ...c.variables, secondary_region: AWS_SECONDARY },
    providers: ["aws"],
    providerConfig: { ...AWS_PROVIDER_CONFIG, ...SECONDARY_PROVIDER_CONFIG },
    data: [
      ...awsData(),
      { address: "data.aws_availability_zones.ireland", providerKey: IE, values: { state: "available", names: ["eu-west-1a", "eu-west-1b", "eu-west-1c"] }, args: ["state"], refs: {} },
      { address: "data.aws_ssm_parameter.al2023_ireland", providerKey: IE, values: { name: "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64", insecure_value: "ami-0fedcba9876543210" }, args: ["name"], refs: {} },
    ],
    resources: [
      ...templateResources(c),
      // london.tf
      {
        address: "aws_subnet.public",
        values: tagged(c, { cidr_block: cidrsubnet(c.vpcCidr, 4, 2), availability_zone: "eu-west-2a", map_public_ip_on_launch: false, tags: { Name: "snet-public-1" } }),
        unknown: ["vpc_id"],
        refs: { vpc_id: ref(VPC, "id"), cidr_block: ["local.vpc_cidr"], availability_zone: ["local.azs[0]", "local.azs"] },
      },
      vpcOnly("aws_internet_gateway.lab", "igw-lab", VPC),
      vpcOnly("aws_route_table.public", "rt-public", VPC),
      { address: "aws_route.public_internet", values: { destination_cidr_block: "0.0.0.0/0" }, unknown: ["route_table_id", "gateway_id"], refs: { route_table_id: ref("aws_route_table.public", "id"), gateway_id: ref("aws_internet_gateway.lab", "id") } },
      assoc("public", "aws_subnet.public", "aws_route_table.public"),
      sg("web", "lab-web", "vm-london: HTTP from anywhere through the NLB, SSH from the Instance Connect Endpoint", "sg-web", VPC),
      rule("ingress", "web_http", "aws_security_group.web", { cidr_ipv4: "0.0.0.0/0", ip_protocol: "tcp", from_port: 80, to_port: 80 }),
      rule("ingress", "web_ssh", "aws_security_group.web", { ip_protocol: "tcp", from_port: 22, to_port: 22 }, { referenced_security_group_id: ref("aws_security_group.eice", "id") }, ["referenced_security_group_id"]),
      rule("egress", "web_all", "aws_security_group.web", { cidr_ipv4: "0.0.0.0/0", ip_protocol: "-1" }),
      london,
      nlb("london", "ldn", "aws_subnet.public", "nlb-ldn"),
      tg("london", "ldn", VPC, "tg-ldn"),
      attach("london", "aws_instance.london"),
      listener("london", "listener-ldn"),
      // ireland.tf
      {
        address: "aws_resourcegroups_group.secondary",
        providerKey: IE,
        values: tagged(c, { name: `lab-${id}`, resource_query: [{ type: "TAG_FILTERS_1_0", query: JSON.stringify({ ResourceTypeFilters: ["AWS::AllSupported"], TagFilters: [{ Key: "cloudlabs-lab", Values: [id] }] }) }] }),
        refs: { name: ["var.lab_id"], "resource_query.0.query": ["var.lab_id"] },
      },
      { address: IE_VPC, providerKey: IE, values: tagged(c, { cidr_block: ieVpcCidr, enable_dns_support: true, enable_dns_hostnames: true, tags: { Name: "vpc-ireland" } }), refs: { cidr_block: ["local.ireland_vpc_cidr"] } },
      ...[["ireland_private", iePrivate, "ireland_private_cidr", "snet-ireland-private"], ["ireland_public", iePublic, "ireland_public_cidr", "snet-ireland-public"]].map(([key, cidr, local, name]) => ({
        address: `aws_subnet.${key}`,
        providerKey: IE,
        values: tagged(c, { cidr_block: cidr, availability_zone: "eu-west-1a", map_public_ip_on_launch: false, tags: { Name: name } }),
        unknown: ["vpc_id"],
        refs: { vpc_id: ref(IE_VPC, "id"), cidr_block: [`local.${local}`], availability_zone: ["data.aws_availability_zones.ireland.names[0]", "data.aws_availability_zones.ireland.names", "data.aws_availability_zones.ireland"] },
      })),
      vpcOnly("aws_internet_gateway.ireland", "igw-ireland", IE_VPC, IE),
      vpcOnly("aws_route_table.ireland_private", "rt-ireland-private", IE_VPC, IE),
      vpcOnly("aws_route_table.ireland_public", "rt-ireland-public", IE_VPC, IE),
      { address: "aws_route.ireland_public_internet", providerKey: IE, values: { destination_cidr_block: "0.0.0.0/0" }, unknown: ["route_table_id", "gateway_id"], refs: { route_table_id: ref("aws_route_table.ireland_public", "id"), gateway_id: ref("aws_internet_gateway.ireland", "id") } },
      assoc("ireland_private", "aws_subnet.ireland_private", "aws_route_table.ireland_private", IE),
      assoc("ireland_public", "aws_subnet.ireland_public", "aws_route_table.ireland_public", IE),
      {
        address: "aws_vpc_endpoint.ireland_s3",
        providerKey: IE,
        values: tagged(c, { service_name: `com.amazonaws.${AWS_SECONDARY}.s3`, vpc_endpoint_type: "Gateway", tags: { Name: "vpce-s3-ireland" } }),
        unknown: ["vpc_id", "route_table_ids"],
        refs: { vpc_id: ref(IE_VPC, "id"), service_name: ["var.secondary_region"], route_table_ids: ref("aws_route_table.ireland_private", "id") },
      },
      sg("ireland_eice", "lab-eice-ireland", "EC2 Instance Connect Endpoint in Ireland: SSH out to vm-ireland", "sg-eice-ireland", IE_VPC, IE),
      rule("egress", "ireland_eice_ssh", "aws_security_group.ireland_eice", { cidr_ipv4: ieVpcCidr, ip_protocol: "tcp", from_port: 22, to_port: 22 }, { cidr_ipv4: ["local.ireland_vpc_cidr"] }, [], IE),
      {
        address: "aws_ec2_instance_connect_endpoint.ireland",
        providerKey: IE,
        values: tagged(c, { preserve_client_ip: false, tags: { Name: "eice-ireland" } }),
        unknown: ["subnet_id", "security_group_ids.0"],
        refs: { subnet_id: ref("aws_subnet.ireland_private", "id"), security_group_ids: ref("aws_security_group.ireland_eice", "id") },
      },
      sg("ireland_web", "lab-web-ireland", "vm-ireland: HTTP from anywhere through the NLB, SSH from the Instance Connect Endpoint", "sg-web-ireland", IE_VPC, IE),
      rule("ingress", "ireland_web_http", "aws_security_group.ireland_web", { cidr_ipv4: "0.0.0.0/0", ip_protocol: "tcp", from_port: 80, to_port: 80 }, {}, [], IE),
      rule("ingress", "ireland_web_ssh", "aws_security_group.ireland_web", { ip_protocol: "tcp", from_port: 22, to_port: 22 }, { referenced_security_group_id: ref("aws_security_group.ireland_eice", "id") }, ["referenced_security_group_id"], IE),
      rule("egress", "ireland_web_all", "aws_security_group.ireland_web", { cidr_ipv4: "0.0.0.0/0", ip_protocol: "-1" }, {}, [], IE),
      ireland,
      nlb("ireland", "dub", "aws_subnet.ireland_public", "nlb-dub", IE),
      tg("ireland", "dub", IE_VPC, "tg-dub", IE),
      attach("ireland", "aws_instance.ireland", IE),
      listener("ireland", "listener-dub", IE),
      // accelerator.tf
      {
        address: "aws_globalaccelerator_accelerator.lab",
        values: tagged(c, { name: `lab-${id}`, ip_address_type: "IPV4", enabled: true, attributes: [{ flow_logs_enabled: false }], tags: { Name: "ga-lab" } }),
        refs: { name: ["var.lab_id"] },
      },
      {
        address: "aws_globalaccelerator_listener.http",
        values: { client_affinity: "NONE", protocol: "TCP", port_range: [{ from_port: 80, to_port: 80 }] },
        unknown: ["accelerator_arn"],
        refs: { accelerator_arn: ref("aws_globalaccelerator_accelerator.lab", "arn") },
      },
      group("london", "eu-west-2", "var.region", "aws_lb.london"),
      group("ireland", AWS_SECONDARY, "var.secondary_region", "aws_lb.ireland"),
      // cdn.tf
      {
        address: "aws_cloudfront_function.headers",
        // No tags argument (CloudFront Functions are owned by name, A4), but the provider schema computes tags_all
        // for every aws type, so the plan carries the default tags there, as for the other resources.
        values: tagged(c, {
          name: `lab-${id}-headers`, runtime: "cloudfront-js-2.0", comment: `lab ${id}: marks each request that came through CloudFront`, publish: true,
          code: "function handler(event) {\n  var request = event.request;\n  request.headers['x-cloudlabs-edge'] = { value: 'cloudfront' };\n  return request;\n}\n",
        }),
        refs: { name: ["var.lab_id"], comment: ["var.lab_id"] },
      },
      {
        address: "aws_cloudfront_distribution.lab",
        values: tagged(c, {
          enabled: true, comment: `lab ${id}`, price_class: "PriceClass_100", retain_on_delete: false, wait_for_deployment: true,
          origin: [
            { origin_id: "london", connection_attempts: 1, connection_timeout: 3, custom_origin_config: customOrigin },
            { origin_id: "ireland", custom_origin_config: customOrigin },
          ],
          origin_group: [{ origin_id: "failover", failover_criteria: [{ status_codes: [500, 502, 503, 504] }], member: [{ origin_id: "london" }, { origin_id: "ireland" }] }],
          default_cache_behavior: [{
            target_origin_id: "failover", viewer_protocol_policy: "redirect-to-https", allowed_methods: ["GET", "HEAD"], cached_methods: ["GET", "HEAD"],
            cache_policy_id: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad", function_association: [{ event_type: "viewer-request" }],
          }],
          restrictions: [{ geo_restriction: [{ restriction_type: "none" }] }],
          viewer_certificate: [{ cloudfront_default_certificate: true }],
          tags: { Name: "cdn-lab" },
        }),
        unknown: ["origin.0.domain_name", "origin.1.domain_name", "default_cache_behavior.0.function_association.0.function_arn", "web_acl_id"],
        refs: {
          comment: ["var.lab_id"],
          "origin.0.domain_name": ref("aws_lb.london", "dns_name"),
          "origin.1.domain_name": ref("aws_lb.ireland", "dns_name"),
          "default_cache_behavior.0.function_association.0.function_arn": ref("aws_cloudfront_function.headers", "arn"),
          "default_cache_behavior.0.cache_policy_id": ["local.caching_disabled"],
          web_acl_id: ref("aws_wafv2_web_acl.lab", "arn"),
        },
      },
      // waf.tf
      {
        address: "aws_wafv2_web_acl.lab",
        values: tagged(c, {
          region: "us-east-1", name: `lab-${id}-waf`, description: `lab ${id}: the CloudFront distribution's web ACL`, scope: "CLOUDFRONT",
          default_action: [{ allow: [{}] }],
          rule: [
            { name: "common", priority: 1, override_action: [{ none: [{}] }], statement: [{ managed_rule_group_statement: [{ name: "AWSManagedRulesCommonRuleSet", vendor_name: "AWS" }] }], visibility_config: [visibility("lab-common")] },
            { name: "rate", priority: 2, action: [{ block: [{}] }], statement: [{ rate_based_statement: [{ limit: 100, evaluation_window_sec: 300, aggregate_key_type: "IP" }] }], visibility_config: [visibility("lab-rate")] },
          ],
          visibility_config: [visibility("lab-waf")],
          tags: { Name: "waf-lab" },
        }),
        refs: { name: ["var.lab_id"], description: ["var.lab_id"] },
      },
    ],
  };
};
