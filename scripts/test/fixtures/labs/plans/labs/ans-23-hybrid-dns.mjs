// scripts/test/fixtures/labs/plans/labs/ans-23-hybrid-dns.mjs
//
// Plain English: lab ans-23's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the template
// network, then onprem.tf (the pretend data centre's VPC, subnet, route table,
// S3 endpoint, peering with its two routes, and Instance Connect Endpoint),
// resolver.tf (sg-resolver, the inbound and outbound endpoints, the FORWARD
// rule and its association, the private zone and its record), dnsfw.tf (the
// domain list, rule group, rule and association), querylog.tf (the bucket, its
// policy, the query log config and its association) and compute.tf (sg-cloud,
// sg-dns, vm-cloud and vm-dns). Every CIDR is built from var.address_space, so
// it is known at plan; the Resolver endpoints' addresses are chosen by AWS
// (unknown), and vm-dns's cloud-init holds the inbound ones (ruling P12), so
// its user data is unknown too.

import { ACCOUNT, AWS_PROVIDER_CONFIG, GATEWAY_CIDR, al2023Instance, awsData, cidrsubnet, ctxAws, ref, tagged, templateResources } from "../common-aws.mjs";

/** A policy document as Terraform's jsonencode prints it: object keys in sorted order. */
const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
const doc = (statements) => JSON.stringify(sorted({ Version: "2012-10-17", Statement: statements }));

export default () => {
  const c = ctxAws("ans-23-hybrid-dns", "23");
  const id = c.id;
  const onprem = cidrsubnet(c.address, 2, 1);
  const onpremSub = cidrsubnet(onprem, 4, 0);
  const base = onpremSub.split("/")[0].split(".");
  const dnsIp = `${base.slice(0, 3).join(".")}.${Number(base[3]) + 10}`;
  const corp = "corp.a23k3x9q.internal";
  const cloud = "cloud.a23k3x9q.internal";
  const bucket = "cloudlabs-a23k3x9q-dnslogs";
  const bucketArn = `arn:aws:s3:::${bucket}`;
  const rule = (kind, key, sg, values, refs = {}, unknown = []) => ({
    address: `aws_vpc_security_group_${kind}_rule.${key}`,
    values: tagged(c, values),
    unknown: ["security_group_id", ...unknown],
    refs: { security_group_id: ref(sg, "id"), ...refs },
  });
  const endpoint = (key, direction, suffix, name) => ({
    address: `aws_route53_resolver_endpoint.${key}`,
    values: tagged(c, { name: `lab-${id}-${suffix}`, direction, protocols: ["Do53"], ip_address: [{}, {}], tags: { Name: name } }),
    unknown: ["security_group_ids", "ip_address.0.subnet_id", "ip_address.0.ip", "ip_address.1.subnet_id", "ip_address.1.ip"],
    refs: {
      name: ["var.lab_id"],
      security_group_ids: ref("aws_security_group.resolver", "id"),
      "ip_address.0.subnet_id": ["aws_subnet.private[0].id", "aws_subnet.private[0]", "aws_subnet.private"],
      "ip_address.1.subnet_id": ["aws_subnet.private[1].id", "aws_subnet.private[1]", "aws_subnet.private"],
    },
  });
  const cloudVm = al2023Instance(c, { key: "cloud", name: "vm-cloud", type: "t4g.nano", sgs: ["aws_security_group.cloud"] });
  cloudVm.refs.user_data = ["local.cloud_cloud_init"];
  const dnsVm = al2023Instance(c, { key: "dns", name: "vm-dns", type: "t4g.nano", subnet: "aws_subnet.onprem", sgs: ["aws_security_group.dns"], userDataUnknown: true });
  dnsVm.values.private_ip = dnsIp;
  dnsVm.refs.private_ip = ["local.dns_ip"];
  dnsVm.refs.user_data = ["local.dns_cloud_init"];
  const onBucket = (type, key, values, extra = {}) => ({ address: `${type}.${key}`, values, unknown: ["bucket", ...(extra.unknown ?? [])], refs: { bucket: ref("aws_s3_bucket.dnslogs", "id"), ...(extra.refs ?? {}) } });
  const delivery = (sid, action, resource, extraCond = {}) => ({
    Sid: sid, Effect: "Allow", Principal: { Service: "delivery.logs.amazonaws.com" }, Action: action, Resource: resource,
    Condition: { StringEquals: { ...extraCond, "aws:SourceAccount": ACCOUNT } },
  });
  return {
    lab: id,
    variables: c.variables,
    providers: ["aws"],
    providerConfig: AWS_PROVIDER_CONFIG,
    data: awsData(),
    resources: [
      ...templateResources(c),
      // onprem.tf
      { address: "aws_vpc.onprem", values: tagged(c, { cidr_block: onprem, enable_dns_support: true, enable_dns_hostnames: true, tags: { Name: "vpc-onprem" } }), refs: { cidr_block: ["local.onprem_cidr"] } },
      { address: "aws_subnet.onprem", values: tagged(c, { cidr_block: onpremSub, availability_zone: "eu-west-2a", map_public_ip_on_launch: false, tags: { Name: "snet-onprem-1" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.onprem", "id"), cidr_block: ["local.onprem_subnet_cidr"], availability_zone: ["local.azs[0]", "local.azs"] } },
      { address: "aws_route_table.onprem", values: tagged(c, { tags: { Name: "rt-onprem" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.onprem", "id") } },
      { address: "aws_route_table_association.onprem", values: {}, unknown: ["subnet_id", "route_table_id"], refs: { subnet_id: ref("aws_subnet.onprem", "id"), route_table_id: ref("aws_route_table.onprem", "id") } },
      { address: "aws_vpc_endpoint.onprem_s3", values: tagged(c, { service_name: "com.amazonaws.eu-west-2.s3", vpc_endpoint_type: "Gateway", tags: { Name: "vpce-s3-onprem" } }), unknown: ["vpc_id", "route_table_ids"], refs: { vpc_id: ref("aws_vpc.onprem", "id"), service_name: ["var.region"], route_table_ids: ref("aws_route_table.onprem", "id") } },
      { address: "aws_vpc_peering_connection.cloud_onprem", values: tagged(c, { auto_accept: true, tags: { Name: "pcx-cloud-onprem" } }), unknown: ["vpc_id", "peer_vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id"), peer_vpc_id: ref("aws_vpc.onprem", "id") } },
      { address: "aws_route.cloud_to_onprem", values: { destination_cidr_block: onprem }, unknown: ["route_table_id", "vpc_peering_connection_id"], refs: { route_table_id: ref("aws_route_table.private", "id"), destination_cidr_block: ["local.onprem_cidr"], vpc_peering_connection_id: ref("aws_vpc_peering_connection.cloud_onprem", "id") } },
      { address: "aws_route.onprem_to_cloud", values: { destination_cidr_block: c.vpcCidr }, unknown: ["route_table_id", "vpc_peering_connection_id"], refs: { route_table_id: ref("aws_route_table.onprem", "id"), destination_cidr_block: ["local.vpc_cidr"], vpc_peering_connection_id: ref("aws_vpc_peering_connection.cloud_onprem", "id") } },
      { address: "aws_security_group.eice_onprem", values: tagged(c, { name: "lab-eice-onprem", description: "Instance Connect Endpoint in vpc-onprem: SSH out to vm-dns", tags: { Name: "sg-eice-onprem" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.onprem", "id") } },
      rule("egress", "eice_onprem_ssh", "aws_security_group.eice_onprem", { cidr_ipv4: onprem, ip_protocol: "tcp", from_port: 22, to_port: 22 }, { cidr_ipv4: ["local.onprem_cidr"] }),
      { address: "aws_ec2_instance_connect_endpoint.onprem", values: tagged(c, { preserve_client_ip: false, tags: { Name: "eice-onprem" } }), unknown: ["subnet_id", "security_group_ids.0"], refs: { subnet_id: ref("aws_subnet.onprem", "id"), security_group_ids: ref("aws_security_group.eice_onprem", "id") } },
      // resolver.tf
      { address: "aws_security_group.resolver", values: tagged(c, { name: "lab-resolver", description: "Resolver endpoints: DNS in from the data centre, DNS out to vm-dns", tags: { Name: "sg-resolver" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } },
      rule("ingress", "resolver_udp", "aws_security_group.resolver", { cidr_ipv4: onprem, ip_protocol: "udp", from_port: 53, to_port: 53 }, { cidr_ipv4: ["local.onprem_cidr"] }),
      rule("ingress", "resolver_tcp", "aws_security_group.resolver", { cidr_ipv4: onprem, ip_protocol: "tcp", from_port: 53, to_port: 53 }, { cidr_ipv4: ["local.onprem_cidr"] }),
      rule("egress", "resolver_out_udp", "aws_security_group.resolver", { cidr_ipv4: `${dnsIp}/32`, ip_protocol: "udp", from_port: 53, to_port: 53 }, { cidr_ipv4: ["local.dns_ip"] }),
      rule("egress", "resolver_out_tcp", "aws_security_group.resolver", { cidr_ipv4: `${dnsIp}/32`, ip_protocol: "tcp", from_port: 53, to_port: 53 }, { cidr_ipv4: ["local.dns_ip"] }),
      endpoint("inbound", "INBOUND", "in", "rslvr-in"),
      endpoint("outbound", "OUTBOUND", "out", "rslvr-out"),
      {
        address: "aws_route53_resolver_rule.corp",
        values: tagged(c, { name: `lab-${id}-corp`, rule_type: "FORWARD", domain_name: corp, target_ip: [{ ip: dnsIp, port: 53 }], tags: { Name: "rule-corp" } }),
        unknown: ["resolver_endpoint_id"],
        refs: { name: ["var.lab_id"], domain_name: ["local.corp_domain"], "target_ip.0.ip": ["local.dns_ip"], resolver_endpoint_id: ref("aws_route53_resolver_endpoint.outbound", "id") },
      },
      { address: "time_sleep.resolver_tags", values: { create_duration: "20s" }, refs: {} },
      { address: "aws_route53_resolver_rule_association.corp", values: { name: `lab-${id}-corp` }, unknown: ["resolver_rule_id", "vpc_id"], refs: { name: ["var.lab_id"], resolver_rule_id: ref("aws_route53_resolver_rule.corp", "id"), vpc_id: ref("aws_vpc.lab", "id") } },
      {
        address: "aws_route53_zone.cloud",
        values: tagged(c, { name: cloud, force_destroy: true, vpc: [{ vpc_region: "eu-west-2" }], tags: { Name: "zone-cloud" } }),
        unknown: ["vpc.0.vpc_id"],
        refs: { name: ["local.cloud_domain"], "vpc.0.vpc_id": ref("aws_vpc.lab", "id"), "vpc.0.vpc_region": ["var.region"] },
      },
      {
        address: "aws_route53_record.app",
        values: { name: `app.${cloud}`, type: "A", ttl: 60 },
        unknown: ["zone_id", "records"],
        refs: { name: ["local.cloud_domain"], zone_id: ref("aws_route53_zone.cloud", "zone_id"), records: ref("aws_instance.cloud", "private_ip") },
      },
      // dnsfw.tf
      { address: "aws_route53_resolver_firewall_domain_list.blocked", values: tagged(c, { name: `lab-${id}-blocked`, domains: ["example.com.", "*.example.com."], tags: { Name: "dnsfw-blocked" } }), refs: { name: ["var.lab_id"] } },
      { address: "aws_route53_resolver_firewall_rule_group.lab", values: tagged(c, { name: `lab-${id}-dnsfw`, tags: { Name: "dnsfw-group" } }), refs: { name: ["var.lab_id"] } },
      {
        address: "aws_route53_resolver_firewall_rule.block",
        values: { name: "block", action: "BLOCK", block_response: "NXDOMAIN", priority: 100 },
        unknown: ["firewall_domain_list_id", "firewall_rule_group_id"],
        refs: { firewall_domain_list_id: ref("aws_route53_resolver_firewall_domain_list.blocked", "id"), firewall_rule_group_id: ref("aws_route53_resolver_firewall_rule_group.lab", "id") },
      },
      {
        address: "aws_route53_resolver_firewall_rule_group_association.lab",
        values: tagged(c, { name: `lab-${id}-dnsfw`, priority: 101, mutation_protection: "DISABLED", tags: { Name: "dnsfw-vpc-lab" } }),
        unknown: ["firewall_rule_group_id", "vpc_id"],
        refs: { name: ["var.lab_id"], firewall_rule_group_id: ref("aws_route53_resolver_firewall_rule_group.lab", "id"), vpc_id: ref("aws_vpc.lab", "id") },
      },
      // querylog.tf
      { address: "aws_s3_bucket.dnslogs", values: tagged(c, { bucket, force_destroy: true, tags: { Name: "dnslogs" } }), refs: { bucket: ["local.dnslogs_bucket"] } },
      onBucket("aws_s3_bucket_public_access_block", "dnslogs", { block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true }),
      onBucket("aws_s3_bucket_policy", "dnslogs", {
        policy: doc([
          delivery("AWSLogDeliveryWrite", "s3:PutObject", `${bucketArn}/AWSLogs/${ACCOUNT}/*`, { "s3:x-amz-acl": "bucket-owner-full-control" }),
          delivery("AWSLogDeliveryAclCheck", "s3:GetBucketAcl", bucketArn),
        ]),
      }, { refs: { policy: ["local.dnslogs_arn", ...ref("data.aws_caller_identity.current", "account_id"), ...ref("data.aws_caller_identity.current", "account_id"), "local.dnslogs_arn", ...ref("data.aws_caller_identity.current", "account_id")] } }),
      {
        address: "aws_route53_resolver_query_log_config.lab",
        values: tagged(c, { name: `lab-${id}-queries`, tags: { Name: "querylog" } }),
        unknown: ["destination_arn"],
        refs: { name: ["var.lab_id"], destination_arn: ref("aws_s3_bucket.dnslogs", "arn") },
      },
      {
        address: "aws_route53_resolver_query_log_config_association.lab",
        values: {},
        unknown: ["resolver_query_log_config_id", "resource_id"],
        refs: { resolver_query_log_config_id: ref("aws_route53_resolver_query_log_config.lab", "id"), resource_id: ref("aws_vpc.lab", "id") },
      },
      // compute.tf
      { address: "aws_security_group.cloud", values: tagged(c, { name: "lab-cloud", description: "vm-cloud: SSH from the Instance Connect Endpoint, HTTP from the data centre, SSH and HTTP from the gateway", tags: { Name: "sg-cloud" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } },
      rule("ingress", "cloud_ssh_eice", "aws_security_group.cloud", { ip_protocol: "tcp", from_port: 22, to_port: 22 }, { referenced_security_group_id: ref("aws_security_group.eice", "id") }, ["referenced_security_group_id"]),
      rule("ingress", "cloud_http_onprem", "aws_security_group.cloud", { cidr_ipv4: onprem, ip_protocol: "tcp", from_port: 80, to_port: 80 }, { cidr_ipv4: ["local.onprem_cidr"] }),
      rule("ingress", "cloud_ssh_gateway", "aws_security_group.cloud", { cidr_ipv4: GATEWAY_CIDR, ip_protocol: "tcp", from_port: 22, to_port: 22 }, { cidr_ipv4: ["var.gateway_cidr"] }),
      rule("ingress", "cloud_http_gateway", "aws_security_group.cloud", { cidr_ipv4: GATEWAY_CIDR, ip_protocol: "tcp", from_port: 80, to_port: 80 }, { cidr_ipv4: ["var.gateway_cidr"] }),
      rule("egress", "cloud_all", "aws_security_group.cloud", { cidr_ipv4: "0.0.0.0/0", ip_protocol: "-1" }),
      { address: "aws_security_group.dns", values: tagged(c, { name: "lab-dns", description: "vm-dns: DNS from the slot, SSH from the Instance Connect Endpoint, SSH and HTTP from the gateway", tags: { Name: "sg-dns" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.onprem", "id") } },
      rule("ingress", "dns_udp", "aws_security_group.dns", { cidr_ipv4: c.address, ip_protocol: "udp", from_port: 53, to_port: 53 }, { cidr_ipv4: ["var.address_space"] }),
      rule("ingress", "dns_tcp", "aws_security_group.dns", { cidr_ipv4: c.address, ip_protocol: "tcp", from_port: 53, to_port: 53 }, { cidr_ipv4: ["var.address_space"] }),
      rule("ingress", "dns_ssh_eice", "aws_security_group.dns", { ip_protocol: "tcp", from_port: 22, to_port: 22 }, { referenced_security_group_id: ref("aws_security_group.eice_onprem", "id") }, ["referenced_security_group_id"]),
      rule("ingress", "dns_ssh_gateway", "aws_security_group.dns", { cidr_ipv4: GATEWAY_CIDR, ip_protocol: "tcp", from_port: 22, to_port: 22 }, { cidr_ipv4: ["var.gateway_cidr"] }),
      rule("ingress", "dns_http_gateway", "aws_security_group.dns", { cidr_ipv4: GATEWAY_CIDR, ip_protocol: "tcp", from_port: 80, to_port: 80 }, { cidr_ipv4: ["var.gateway_cidr"] }),
      rule("egress", "dns_all", "aws_security_group.dns", { cidr_ipv4: "0.0.0.0/0", ip_protocol: "-1" }),
      cloudVm,
      dnsVm,
    ],
  };
};
