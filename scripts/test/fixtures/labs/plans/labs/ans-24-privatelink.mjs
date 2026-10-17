// scripts/test/fixtures/labs/plans/labs/ans-24-privatelink.mjs
//
// Plain English: lab ans-24's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the template
// network, then provider-vpc.tf (vpc-provider, its two subnets, route table,
// S3 endpoint and Instance Connect Endpoint), service.tf (the internal Network
// Load Balancer, its target group, attachment and listener, and the endpoint
// service), consumer.tf (sg-endpoint, the interface endpoint, the private zone
// and its alias, the S3 endpoint's policy, the bucket and its object), iam.tf
// (the consumer role, policy, attachment and profile) and compute.tf (sg-consumer,
// sg-provider and the two instances). Every CIDR comes from var.address_space,
// and the policies from the caller identity, the name prefix and the region, so
// they are known at plan; the service name, the endpoint's DNS entries and
// every id are not. No private IP is fixed, so nothing can collide with an
// Instance Connect Endpoint's own address.

import { ACCOUNT, AWS_PROVIDER_CONFIG, BOUNDARY, GATEWAY_CIDR, al2023Instance, awsData, cidrsubnet, ctxAws, ref, tagged, templateResources } from "../common-aws.mjs";

/** A policy document as Terraform's jsonencode prints it: object keys in sorted order. */
const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
const doc = (statements) => JSON.stringify(sorted({ Version: "2012-10-17", Statement: statements }));

export default () => {
  const c = ctxAws("ans-24-privatelink", "24");
  const id = c.id;
  const prov = cidrsubnet(c.address, 2, 1);
  const bucket = "cloudlabs-a24k3x9q-data";
  const bucketArn = `arn:aws:s3:::${bucket}`;
  const svc = "svc.a24k3x9q.internal";
  const rule = (kind, key, sg, values, refs = {}, unknown = []) => ({
    address: `aws_vpc_security_group_${kind}_rule.${key}`,
    values: tagged(c, values),
    unknown: ["security_group_id", ...unknown],
    refs: { security_group_id: ref(sg, "id"), ...refs },
  });
  const consumerVm = al2023Instance(c, { key: "consumer", name: "vm-consumer", type: "t4g.nano", profile: "aws_iam_instance_profile.consumer", sgs: ["aws_security_group.consumer"] });
  consumerVm.refs.user_data = ['local.web_cloud_init["consumer"]', "local.web_cloud_init"];
  const providerVm = al2023Instance(c, { key: "provider", name: "vm-provider", type: "t4g.nano", subnet: "aws_subnet.provider[0]", sgs: ["aws_security_group.provider"] });
  providerVm.refs.user_data = ['local.web_cloud_init["provider"]', "local.web_cloud_init"];
  return {
    lab: id,
    variables: c.variables,
    providers: ["aws"],
    providerConfig: AWS_PROVIDER_CONFIG,
    data: awsData(),
    resources: [
      ...templateResources(c),
      // provider-vpc.tf
      { address: "aws_vpc.provider", values: tagged(c, { cidr_block: prov, enable_dns_support: true, enable_dns_hostnames: true, tags: { Name: "vpc-provider" } }), refs: { cidr_block: ["local.provider_cidr"] } },
      ...[0, 1].map((i) => ({
        address: `aws_subnet.provider[${i}]`, count: 2,
        values: tagged(c, { cidr_block: cidrsubnet(prov, 4, i), availability_zone: `eu-west-2${"ab"[i]}`, map_public_ip_on_launch: false, tags: { Name: `snet-provider-${i + 1}` } }),
        unknown: ["vpc_id"],
        refs: { vpc_id: ref("aws_vpc.provider", "id"), cidr_block: ["local.provider_cidr", "count.index"], availability_zone: ["local.azs", "count.index"], tags: ["count.index"] },
      })),
      { address: "aws_route_table.provider", values: tagged(c, { tags: { Name: "rt-provider" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.provider", "id") } },
      ...[0, 1].map((i) => ({
        address: `aws_route_table_association.provider[${i}]`, count: 2, values: {}, unknown: ["subnet_id", "route_table_id"],
        refs: { subnet_id: ["aws_subnet.provider", "count.index"], route_table_id: ref("aws_route_table.provider", "id") },
      })),
      { address: "aws_vpc_endpoint.provider_s3", values: tagged(c, { service_name: "com.amazonaws.eu-west-2.s3", vpc_endpoint_type: "Gateway", tags: { Name: "vpce-s3-provider" } }), unknown: ["vpc_id", "route_table_ids"], refs: { vpc_id: ref("aws_vpc.provider", "id"), service_name: ["var.region"], route_table_ids: ref("aws_route_table.provider", "id") } },
      { address: "aws_security_group.eice_provider", values: tagged(c, { name: "lab-eice-provider", description: "Instance Connect Endpoint in vpc-provider: SSH out to vm-provider", tags: { Name: "sg-eice-provider" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.provider", "id") } },
      rule("egress", "eice_provider_ssh", "aws_security_group.eice_provider", { cidr_ipv4: prov, ip_protocol: "tcp", from_port: 22, to_port: 22 }, { cidr_ipv4: ["local.provider_cidr"] }),
      { address: "aws_ec2_instance_connect_endpoint.provider", values: tagged(c, { preserve_client_ip: false, tags: { Name: "eice-provider" } }), unknown: ["subnet_id", "security_group_ids.0"], refs: { subnet_id: ["aws_subnet.provider[0].id", "aws_subnet.provider[0]", "aws_subnet.provider"], security_group_ids: ref("aws_security_group.eice_provider", "id") } },
      // service.tf
      {
        address: "aws_lb.provider",
        values: tagged(c, { name: "nlb-a24k3x9q", internal: true, load_balancer_type: "network", enable_deletion_protection: false, tags: { Name: "nlb-provider" } }),
        unknown: ["subnets"],
        refs: { name: ["var.name_prefix"], subnets: ["aws_subnet.provider"] },
      },
      {
        address: "aws_lb_target_group.provider",
        values: tagged(c, {
          name: "tg-a24k3x9q", port: 80, protocol: "TCP", target_type: "instance", preserve_client_ip: "false",
          health_check: [{ protocol: "TCP", interval: 10, healthy_threshold: 2, unhealthy_threshold: 2 }],
          tags: { Name: "tg-provider" },
        }),
        unknown: ["vpc_id"],
        refs: { name: ["var.name_prefix"], vpc_id: ref("aws_vpc.provider", "id") },
      },
      {
        address: "aws_lb_target_group_attachment.provider",
        values: { port: 80 },
        unknown: ["target_group_arn", "target_id"],
        refs: { target_group_arn: ref("aws_lb_target_group.provider", "arn"), target_id: ref("aws_instance.provider", "id") },
      },
      {
        address: "aws_lb_listener.provider",
        values: tagged(c, { port: 80, protocol: "TCP", default_action: [{ type: "forward" }], tags: { Name: "listener-tcp-80" } }),
        unknown: ["load_balancer_arn", "default_action.0.target_group_arn"],
        refs: { load_balancer_arn: ref("aws_lb.provider", "arn"), "default_action.0.target_group_arn": ref("aws_lb_target_group.provider", "arn") },
      },
      {
        address: "aws_vpc_endpoint_service.lab",
        values: tagged(c, { acceptance_required: false, allowed_principals: [`arn:aws:iam::${ACCOUNT}:root`], tags: { Name: "vpces-lab" } }),
        unknown: ["network_load_balancer_arns"],
        refs: { network_load_balancer_arns: ref("aws_lb.provider", "arn"), allowed_principals: ref("data.aws_caller_identity.current", "account_id") },
      },
      // consumer.tf
      { address: "aws_security_group.endpoint", values: tagged(c, { name: "lab-endpoint", description: "The interface endpoint: HTTP from vpc-lab", tags: { Name: "sg-endpoint" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } },
      rule("ingress", "endpoint_http", "aws_security_group.endpoint", { cidr_ipv4: c.vpcCidr, ip_protocol: "tcp", from_port: 80, to_port: 80 }, { cidr_ipv4: ["local.vpc_cidr"] }),
      {
        address: "aws_vpc_endpoint.svc",
        values: tagged(c, { vpc_endpoint_type: "Interface", private_dns_enabled: false, tags: { Name: "vpce-svc" } }),
        unknown: ["vpc_id", "service_name", "subnet_ids", "security_group_ids"],
        refs: {
          vpc_id: ref("aws_vpc.lab", "id"),
          service_name: ref("aws_vpc_endpoint_service.lab", "service_name"),
          subnet_ids: ["aws_subnet.private[0].id", "aws_subnet.private[0]", "aws_subnet.private"],
          security_group_ids: ref("aws_security_group.endpoint", "id"),
        },
      },
      {
        address: "aws_route53_zone.svc",
        values: tagged(c, { name: svc, force_destroy: true, vpc: [{ vpc_region: "eu-west-2" }], tags: { Name: "zone-svc" } }),
        unknown: ["vpc.0.vpc_id"],
        refs: { name: ["local.svc_domain"], "vpc.0.vpc_id": ref("aws_vpc.lab", "id"), "vpc.0.vpc_region": ["var.region"] },
      },
      {
        address: "aws_route53_record.app",
        values: { name: `app.${svc}`, type: "A", alias: [{ evaluate_target_health: false }] },
        unknown: ["zone_id", "alias.0.name", "alias.0.zone_id"],
        refs: {
          name: ["local.svc_domain"],
          zone_id: ref("aws_route53_zone.svc", "zone_id"),
          "alias.0.name": ["aws_vpc_endpoint.svc.dns_entry[0].dns_name", "aws_vpc_endpoint.svc.dns_entry[0]", "aws_vpc_endpoint.svc.dns_entry", "aws_vpc_endpoint.svc"],
          "alias.0.zone_id": ["aws_vpc_endpoint.svc.dns_entry[0].hosted_zone_id", "aws_vpc_endpoint.svc.dns_entry[0]", "aws_vpc_endpoint.svc.dns_entry", "aws_vpc_endpoint.svc"],
        },
      },
      {
        address: "aws_vpc_endpoint_policy.s3",
        values: {
          policy: doc([
            { Sid: "LabBucketOnly", Effect: "Allow", Principal: "*", Action: "s3:*", Resource: [bucketArn, `${bucketArn}/*`] },
            { Sid: "AmazonLinuxRepositories", Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: "arn:aws:s3:::al2023-repos-eu-west-2-*/*" },
          ]),
        },
        unknown: ["vpc_endpoint_id"],
        refs: { vpc_endpoint_id: ref("aws_vpc_endpoint.s3", "id"), policy: ["local.data_arn", "local.data_arn", "var.region"] },
      },
      { address: "aws_s3_bucket.data", values: tagged(c, { bucket, force_destroy: true, tags: { Name: "data" } }), refs: { bucket: ["local.data_bucket"] } },
      { address: "aws_s3_bucket_public_access_block.data", values: { block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true }, unknown: ["bucket"], refs: { bucket: ref("aws_s3_bucket.data", "id") } },
      {
        address: "aws_s3_object.hello",
        values: tagged(c, { key: "hello.txt", content: "read through the S3 gateway endpoint, whose policy allows only this bucket\n", content_type: "text/plain" }),
        unknown: ["bucket"],
        refs: { bucket: ref("aws_s3_bucket.data", "id") },
      },
      // iam.tf
      {
        address: "aws_iam_role.consumer",
        values: tagged(c, { name: `lab-${id}-consumer`, path: "/cloudlabs-lab/", permissions_boundary: BOUNDARY, assume_role_policy: doc([{ Effect: "Allow", Principal: { Service: "ec2.amazonaws.com" }, Action: "sts:AssumeRole" }]) }),
        refs: { name: ["var.lab_id"], permissions_boundary: ["local.boundary_arn"] },
      },
      {
        address: "aws_iam_policy.s3_read",
        values: tagged(c, {
          name: `lab-${id}-s3-read`, path: "/cloudlabs-lab/",
          policy: doc([
            { Sid: "LabBucketList", Effect: "Allow", Action: "s3:ListBucket", Resource: bucketArn },
            { Sid: "LabBucketRead", Effect: "Allow", Action: "s3:GetObject", Resource: `${bucketArn}/*` },
          ]),
        }),
        refs: { name: ["var.lab_id"], policy: ["local.data_arn", "local.data_arn"] },
      },
      {
        address: "aws_iam_role_policy_attachment.consumer",
        values: { role: `lab-${id}-consumer` },
        unknown: ["policy_arn"],
        refs: { role: ref("aws_iam_role.consumer", "name"), policy_arn: ref("aws_iam_policy.s3_read", "arn") },
      },
      { address: "aws_iam_instance_profile.consumer", values: tagged(c, { name: `lab-${id}-consumer`, path: "/cloudlabs-lab/", role: `lab-${id}-consumer` }), refs: { name: ["var.lab_id"], role: ref("aws_iam_role.consumer", "name") } },
      // compute.tf
      { address: "aws_security_group.consumer", values: tagged(c, { name: "lab-consumer", description: "vm-consumer: SSH from the Instance Connect Endpoint, SSH and HTTP from the gateway", tags: { Name: "sg-consumer" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } },
      rule("ingress", "consumer_ssh_eice", "aws_security_group.consumer", { ip_protocol: "tcp", from_port: 22, to_port: 22 }, { referenced_security_group_id: ref("aws_security_group.eice", "id") }, ["referenced_security_group_id"]),
      rule("ingress", "consumer_ssh_gateway", "aws_security_group.consumer", { cidr_ipv4: GATEWAY_CIDR, ip_protocol: "tcp", from_port: 22, to_port: 22 }, { cidr_ipv4: ["var.gateway_cidr"] }),
      rule("ingress", "consumer_http_gateway", "aws_security_group.consumer", { cidr_ipv4: GATEWAY_CIDR, ip_protocol: "tcp", from_port: 80, to_port: 80 }, { cidr_ipv4: ["var.gateway_cidr"] }),
      rule("egress", "consumer_all", "aws_security_group.consumer", { cidr_ipv4: "0.0.0.0/0", ip_protocol: "-1" }),
      { address: "aws_security_group.provider", values: tagged(c, { name: "lab-provider", description: "vm-provider: HTTP from vpc-provider (the load balancer), SSH from the Instance Connect Endpoint, SSH and HTTP from the gateway", tags: { Name: "sg-provider" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.provider", "id") } },
      rule("ingress", "provider_http", "aws_security_group.provider", { cidr_ipv4: prov, ip_protocol: "tcp", from_port: 80, to_port: 80 }, { cidr_ipv4: ["local.provider_cidr"] }),
      rule("ingress", "provider_ssh_eice", "aws_security_group.provider", { ip_protocol: "tcp", from_port: 22, to_port: 22 }, { referenced_security_group_id: ref("aws_security_group.eice_provider", "id") }, ["referenced_security_group_id"]),
      rule("ingress", "provider_ssh_gateway", "aws_security_group.provider", { cidr_ipv4: GATEWAY_CIDR, ip_protocol: "tcp", from_port: 22, to_port: 22 }, { cidr_ipv4: ["var.gateway_cidr"] }),
      rule("ingress", "provider_http_gateway", "aws_security_group.provider", { cidr_ipv4: GATEWAY_CIDR, ip_protocol: "tcp", from_port: 80, to_port: 80 }, { cidr_ipv4: ["var.gateway_cidr"] }),
      rule("egress", "provider_all", "aws_security_group.provider", { cidr_ipv4: "0.0.0.0/0", ip_protocol: "-1" }),
      consumerVm,
      providerVm,
    ],
  };
};
