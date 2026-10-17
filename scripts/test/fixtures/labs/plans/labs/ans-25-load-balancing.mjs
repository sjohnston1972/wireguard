// scripts/test/fixtures/labs/plans/labs/ans-25-load-balancing.mjs
//
// Plain English: lab ans-25's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the aws provider computes): the template
// network, then subnets.tf (the public, appliance, endpoint and inspected
// subnets, the gateway, the two Elastic IPs, the NAT gateway, four route tables
// and their routes), certs.tf (the four tls resources and the imported
// certificate), alb.tf (the ALB, its security group, two target groups, the
// listeners and the path rule), nlb.tf (the NLB with its Elastic IP, two TCP
// target groups, the TLS and proxy protocol listeners), gwlb.tf (the Gateway
// Load Balancer, its GENEVE target group, the endpoint service and the
// endpoint) and compute.tf (sg-web, sg-appliance, sg-client and the four
// instances). Every CIDR comes from var.address_space and every name from the
// name prefix, so they are known at plan; ids, ARNs and the certificate
// material are not. No private IP is fixed, so nothing can collide with an
// Instance Connect Endpoint's own address.

import { ACCOUNT, AWS_PROVIDER_CONFIG, al2023Instance, awsData, cidrsubnet, ctxAws, ref, tagged, templateResources } from "../common-aws.mjs";

export default () => {
  const c = ctxAws("ans-25-load-balancing", "25");
  const p = c.prefix;
  const pub = [2, 3].map((n) => cidrsubnet(c.vpcCidr, 4, n));
  const [appCidr, gwlbeCidr, inspCidr] = [4, 5, 6].map((n) => cidrsubnet(c.vpcCidr, 4, n));
  const rule = (kind, key, sg, values, refs = {}, unknown = []) => ({
    address: `aws_vpc_security_group_${kind}_rule.${key}`,
    values: tagged(c, values),
    unknown: ["security_group_id", ...unknown],
    refs: { security_group_id: ref(sg, "id"), ...refs },
  });
  const sg = (key, name, description) => ({ address: `aws_security_group.${key}`, values: tagged(c, { name, description, tags: { Name: `sg-${key}` } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } });
  const vpcOnly = (address, name) => ({ address, values: tagged(c, { tags: { Name: name } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } });
  const subnet = (key, cidr, local, name) => ({
    address: `aws_subnet.${key}`,
    values: tagged(c, { cidr_block: cidr, availability_zone: "eu-west-2a", map_public_ip_on_launch: false, tags: { Name: name } }),
    unknown: ["vpc_id"],
    refs: { vpc_id: ref("aws_vpc.lab", "id"), cidr_block: [`local.${local}`], availability_zone: ["local.azs[0]", "local.azs"] },
  });
  const route = (key, table, cidr, targetAttr, targetRef, cidrRefs = {}) => ({
    address: `aws_route.${key}`,
    values: { destination_cidr_block: cidr },
    unknown: ["route_table_id", targetAttr],
    refs: { route_table_id: ref(table, "id"), [targetAttr]: ref(targetRef, "id"), ...cidrRefs },
  });
  const assoc = (key, subnetAddr, table, idx) => ({
    address: `aws_route_table_association.${key}${idx === undefined ? "" : `[${idx}]`}`,
    ...(idx === undefined ? {} : { count: 2 }),
    values: {},
    unknown: ["subnet_id", "route_table_id"],
    refs: { subnet_id: idx === undefined ? ref(subnetAddr, "id") : [subnetAddr, "count.index"], route_table_id: ref(table, "id") },
  });
  const tg = (key, name, values) => ({
    address: `aws_lb_target_group.${key}`,
    values: tagged(c, { name, ...values }),
    unknown: ["vpc_id"],
    refs: { name: ["var.name_prefix"], vpc_id: ref("aws_vpc.lab", "id") },
  });
  const attach = (key, group, instance, withPort = true) => ({
    address: `aws_lb_target_group_attachment.${key}`,
    values: withPort ? { port: 80 } : {},
    unknown: ["target_group_arn", "target_id"],
    refs: { target_group_arn: ref(group, "arn"), target_id: ref(instance, "id") },
  });
  const health = { path: "/", interval: 15, healthy_threshold: 2, unhealthy_threshold: 2, matcher: "200" };
  const vm = (key, name, type, subnetAddr, sgs, unit) => {
    const v = al2023Instance(c, { key, name, type, subnet: subnetAddr, sgs: ["aws_security_group.vms", ...sgs] });
    v.refs.user_data = [`local.${unit}`];
    return v;
  };
  return {
    lab: c.id,
    variables: c.variables,
    providers: ["aws"],
    providerConfig: AWS_PROVIDER_CONFIG,
    data: awsData(),
    resources: [
      ...templateResources(c),
      // subnets.tf
      ...[0, 1].map((i) => ({
        address: `aws_subnet.public[${i}]`, count: 2,
        values: tagged(c, { cidr_block: pub[i], availability_zone: `eu-west-2${"ab"[i]}`, map_public_ip_on_launch: false, tags: { Name: `snet-public-${i + 1}` } }),
        unknown: ["vpc_id"],
        refs: { vpc_id: ref("aws_vpc.lab", "id"), cidr_block: ["local.public_cidrs", "count.index"], availability_zone: ["local.azs", "count.index"], tags: ["count.index"] },
      })),
      subnet("appliance", appCidr, "appliance_cidr", "snet-appliance"),
      subnet("gwlbe", gwlbeCidr, "gwlbe_cidr", "snet-gwlbe"),
      subnet("inspected", inspCidr, "inspected_cidr", "snet-inspected"),
      vpcOnly("aws_internet_gateway.lab", "igw-lab"),
      { address: "aws_eip.nat", values: tagged(c, { domain: "vpc", tags: { Name: "eip-nat" } }) },
      { address: "aws_eip.nlb", values: tagged(c, { domain: "vpc", tags: { Name: "eip-nlb" } }) },
      { address: "aws_nat_gateway.lab", values: tagged(c, { tags: { Name: "nat-lab" } }), unknown: ["allocation_id", "subnet_id"], refs: { allocation_id: ref("aws_eip.nat", "id"), subnet_id: ["aws_subnet.public[0].id", "aws_subnet.public[0]", "aws_subnet.public"] } },
      vpcOnly("aws_route_table.public", "rt-public"),
      vpcOnly("aws_route_table.appliance", "rt-appliance"),
      vpcOnly("aws_route_table.gwlbe", "rt-gwlbe"),
      vpcOnly("aws_route_table.inspected", "rt-inspected"),
      route("public_internet", "aws_route_table.public", "0.0.0.0/0", "gateway_id", "aws_internet_gateway.lab"),
      route("public_inspected", "aws_route_table.public", inspCidr, "vpc_endpoint_id", "aws_vpc_endpoint.gwlb", { destination_cidr_block: ["local.inspected_cidr"] }),
      route("appliance_nat", "aws_route_table.appliance", "0.0.0.0/0", "nat_gateway_id", "aws_nat_gateway.lab"),
      route("gwlbe_nat", "aws_route_table.gwlbe", "0.0.0.0/0", "nat_gateway_id", "aws_nat_gateway.lab"),
      route("inspected_gwlbe", "aws_route_table.inspected", "0.0.0.0/0", "vpc_endpoint_id", "aws_vpc_endpoint.gwlb"),
      assoc("public", "aws_subnet.public", "aws_route_table.public", 0),
      assoc("public", "aws_subnet.public", "aws_route_table.public", 1),
      assoc("appliance", "aws_subnet.appliance", "aws_route_table.appliance"),
      assoc("gwlbe", "aws_subnet.gwlbe", "aws_route_table.gwlbe"),
      assoc("inspected", "aws_subnet.inspected", "aws_route_table.inspected"),
      // certs.tf
      { address: "tls_private_key.ca", values: { algorithm: "RSA", rsa_bits: 2048 } },
      { address: "tls_private_key.server", values: { algorithm: "RSA", rsa_bits: 2048 } },
      {
        address: "tls_self_signed_cert.ca",
        values: { is_ca_certificate: true, validity_period_hours: 168, allowed_uses: ["cert_signing", "crl_signing"], subject: [{ common_name: "cloudlabs ans-25 CA", organization: "cloudlabs" }] },
        unknown: ["private_key_pem"],
        refs: { private_key_pem: ref("tls_private_key.ca", "private_key_pem") },
      },
      {
        address: "tls_cert_request.server",
        values: { dns_names: [`app.${p}.internal`], subject: [{ common_name: `app.${p}.internal`, organization: "cloudlabs" }] },
        unknown: ["private_key_pem"],
        refs: { private_key_pem: ref("tls_private_key.server", "private_key_pem"), dns_names: ["var.name_prefix"], "subject.0.common_name": ["var.name_prefix"] },
      },
      {
        address: "tls_locally_signed_cert.server",
        values: { validity_period_hours: 168, allowed_uses: ["server_auth", "digital_signature", "key_encipherment"] },
        unknown: ["cert_request_pem", "ca_private_key_pem", "ca_cert_pem"],
        refs: { cert_request_pem: ref("tls_cert_request.server", "cert_request_pem"), ca_private_key_pem: ref("tls_private_key.ca", "private_key_pem"), ca_cert_pem: ref("tls_self_signed_cert.ca", "cert_pem") },
      },
      {
        address: "aws_acm_certificate.app",
        values: tagged(c, { tags: { Name: "cert-app" } }),
        unknown: ["private_key", "certificate_body", "certificate_chain"],
        refs: { private_key: ref("tls_private_key.server", "private_key_pem"), certificate_body: ref("tls_locally_signed_cert.server", "cert_pem"), certificate_chain: ref("tls_self_signed_cert.ca", "cert_pem") },
      },
      // alb.tf
      sg("alb", "lab-alb", "The ALB: HTTP and HTTPS from the internet, HTTP on to the web instances"),
      rule("ingress", "alb_http", "aws_security_group.alb", { cidr_ipv4: "0.0.0.0/0", ip_protocol: "tcp", from_port: 80, to_port: 80 }),
      rule("ingress", "alb_https", "aws_security_group.alb", { cidr_ipv4: "0.0.0.0/0", ip_protocol: "tcp", from_port: 443, to_port: 443 }),
      rule("egress", "alb_to_web", "aws_security_group.alb", { ip_protocol: "tcp", from_port: 80, to_port: 80 }, { referenced_security_group_id: ref("aws_security_group.web", "id") }, ["referenced_security_group_id"]),
      {
        address: "aws_lb.alb",
        values: tagged(c, { name: `alb-${p}`, internal: false, load_balancer_type: "application", enable_deletion_protection: false, tags: { Name: "alb-app" } }),
        unknown: ["security_groups", "subnets"],
        refs: { name: ["var.name_prefix"], security_groups: ref("aws_security_group.alb", "id"), subnets: ref("aws_subnet.public", "id") },
      },
      tg("blue", `tg-${p}-blue`, { port: 80, protocol: "HTTP", deregistration_delay: "30", health_check: [health], tags: { Name: "tg-blue" } }),
      tg("green", `tg-${p}-green`, { port: 80, protocol: "HTTP", deregistration_delay: "30", health_check: [health], tags: { Name: "tg-green" } }),
      attach("blue", "aws_lb_target_group.blue", "aws_instance.blue"),
      attach("green", "aws_lb_target_group.green", "aws_instance.green"),
      {
        address: "aws_lb_listener.http",
        values: tagged(c, { port: 80, protocol: "HTTP", default_action: [{ type: "redirect", redirect: [{ port: "443", protocol: "HTTPS", status_code: "HTTP_301" }] }], tags: { Name: "listener-http" } }),
        unknown: ["load_balancer_arn"],
        refs: { load_balancer_arn: ref("aws_lb.alb", "arn") },
      },
      {
        address: "aws_lb_listener.https",
        values: tagged(c, { port: 443, protocol: "HTTPS", ssl_policy: "ELBSecurityPolicy-TLS13-1-2-2021-06", default_action: [{ type: "forward", forward: [{ target_group: [{ weight: 80 }, { weight: 20 }] }] }], tags: { Name: "listener-https" } }),
        unknown: ["load_balancer_arn", "certificate_arn", "default_action.0.forward.0.target_group.0.arn", "default_action.0.forward.0.target_group.1.arn"],
        refs: {
          load_balancer_arn: ref("aws_lb.alb", "arn"),
          certificate_arn: ref("aws_acm_certificate.app", "arn"),
          "default_action.0.forward.0.target_group": [...ref("aws_lb_target_group.blue", "arn"), ...ref("aws_lb_target_group.green", "arn")],
        },
      },
      {
        address: "aws_lb_listener_rule.green",
        values: tagged(c, { priority: 10, action: [{ type: "forward" }], condition: [{ path_pattern: [{ values: ["/green/*"] }] }], tags: { Name: "rule-green" } }),
        unknown: ["listener_arn", "action.0.target_group_arn"],
        refs: { listener_arn: ref("aws_lb_listener.https", "arn"), "action.0.target_group_arn": ref("aws_lb_target_group.green", "arn") },
      },
      // nlb.tf
      sg("nlb", "lab-nlb", "The NLB: TLS 443 and TCP 8080 from the internet, HTTP on to the web instances"),
      rule("ingress", "nlb_tls", "aws_security_group.nlb", { cidr_ipv4: "0.0.0.0/0", ip_protocol: "tcp", from_port: 443, to_port: 443 }),
      rule("ingress", "nlb_pp", "aws_security_group.nlb", { cidr_ipv4: "0.0.0.0/0", ip_protocol: "tcp", from_port: 8080, to_port: 8080 }),
      rule("egress", "nlb_to_web", "aws_security_group.nlb", { ip_protocol: "tcp", from_port: 80, to_port: 80 }, { referenced_security_group_id: ref("aws_security_group.web", "id") }, ["referenced_security_group_id"]),
      {
        address: "aws_lb.nlb",
        values: tagged(c, { name: `nlb-${p}`, internal: false, load_balancer_type: "network", enable_deletion_protection: false, subnet_mapping: [{}], tags: { Name: "nlb-app" } }),
        unknown: ["security_groups", "subnet_mapping.0.subnet_id", "subnet_mapping.0.allocation_id"],
        refs: {
          name: ["var.name_prefix"],
          security_groups: ref("aws_security_group.nlb", "id"),
          "subnet_mapping.0.subnet_id": ["aws_subnet.public[0].id", "aws_subnet.public[0]", "aws_subnet.public"],
          "subnet_mapping.0.allocation_id": ref("aws_eip.nlb", "id"),
        },
      },
      tg("web", `tgn-${p}-web`, { port: 80, protocol: "TCP", tags: { Name: "tgn-web" } }),
      tg("pp", `tgn-${p}-pp`, { port: 80, protocol: "TCP", proxy_protocol_v2: true, tags: { Name: "tgn-pp" } }),
      attach("nlb_web", "aws_lb_target_group.web", "aws_instance.blue"),
      attach("nlb_pp", "aws_lb_target_group.pp", "aws_instance.green"),
      {
        address: "aws_lb_listener.tls",
        values: tagged(c, { port: 443, protocol: "TLS", ssl_policy: "ELBSecurityPolicy-TLS13-1-2-2021-06", default_action: [{ type: "forward" }], tags: { Name: "listener-tls" } }),
        unknown: ["load_balancer_arn", "certificate_arn", "default_action.0.target_group_arn"],
        refs: { load_balancer_arn: ref("aws_lb.nlb", "arn"), certificate_arn: ref("aws_acm_certificate.app", "arn"), "default_action.0.target_group_arn": ref("aws_lb_target_group.web", "arn") },
      },
      {
        address: "aws_lb_listener.pp",
        values: tagged(c, { port: 8080, protocol: "TCP", default_action: [{ type: "forward" }], tags: { Name: "listener-pp" } }),
        unknown: ["load_balancer_arn", "default_action.0.target_group_arn"],
        refs: { load_balancer_arn: ref("aws_lb.nlb", "arn"), "default_action.0.target_group_arn": ref("aws_lb_target_group.pp", "arn") },
      },
      // gwlb.tf
      {
        address: "aws_lb.gwlb",
        values: tagged(c, { name: `gwlb-${p}`, load_balancer_type: "gateway", enable_deletion_protection: false, tags: { Name: "gwlb-appliance" } }),
        unknown: ["subnets"],
        refs: { name: ["var.name_prefix"], subnets: ref("aws_subnet.appliance", "id") },
      },
      tg("gwlb", `tgg-${p}`, { port: 6081, protocol: "GENEVE", target_type: "instance", health_check: [{ protocol: "HTTP", port: "8080", path: "/", interval: 15, healthy_threshold: 2, unhealthy_threshold: 2 }], tags: { Name: "tgg-appliance" } }),
      attach("appliance", "aws_lb_target_group.gwlb", "aws_instance.appliance", false),
      {
        address: "aws_lb_listener.gwlb",
        values: tagged(c, { default_action: [{ type: "forward" }], tags: { Name: "listener-gwlb" } }),
        unknown: ["load_balancer_arn", "default_action.0.target_group_arn"],
        refs: { load_balancer_arn: ref("aws_lb.gwlb", "arn"), "default_action.0.target_group_arn": ref("aws_lb_target_group.gwlb", "arn") },
      },
      {
        address: "aws_vpc_endpoint_service.gwlb",
        values: tagged(c, { acceptance_required: false, allowed_principals: [`arn:aws:iam::${ACCOUNT}:root`], tags: { Name: "vpces-gwlb" } }),
        unknown: ["gateway_load_balancer_arns"],
        refs: { gateway_load_balancer_arns: ref("aws_lb.gwlb", "arn"), allowed_principals: ref("data.aws_caller_identity.current", "account_id") },
      },
      {
        address: "aws_vpc_endpoint.gwlb",
        values: tagged(c, { vpc_endpoint_type: "GatewayLoadBalancer", tags: { Name: "vpce-gwlb" } }),
        unknown: ["vpc_id", "service_name", "subnet_ids"],
        refs: { vpc_id: ref("aws_vpc.lab", "id"), service_name: ref("aws_vpc_endpoint_service.gwlb", "service_name"), subnet_ids: ref("aws_subnet.gwlbe", "id") },
      },
      // compute.tf
      sg("web", "lab-web", "Web instances: HTTP from the ALB and the NLB"),
      rule("ingress", "web_from_alb", "aws_security_group.web", { ip_protocol: "tcp", from_port: 80, to_port: 80 }, { referenced_security_group_id: ref("aws_security_group.alb", "id") }, ["referenced_security_group_id"]),
      rule("ingress", "web_from_nlb", "aws_security_group.web", { ip_protocol: "tcp", from_port: 80, to_port: 80 }, { referenced_security_group_id: ref("aws_security_group.nlb", "id") }, ["referenced_security_group_id"]),
      sg("appliance", "lab-appliance", "The appliance: GENEVE and health checks from the GWLB subnet"),
      rule("ingress", "appliance_geneve", "aws_security_group.appliance", { cidr_ipv4: appCidr, ip_protocol: "udp", from_port: 6081, to_port: 6081 }, { cidr_ipv4: ["local.appliance_cidr"] }),
      rule("ingress", "appliance_health", "aws_security_group.appliance", { cidr_ipv4: appCidr, ip_protocol: "tcp", from_port: 8080, to_port: 8080 }, { cidr_ipv4: ["local.appliance_cidr"] }),
      sg("client", "lab-client", "vm-client: ping from the lab VPC"),
      rule("ingress", "client_ping", "aws_security_group.client", { cidr_ipv4: c.vpcCidr, ip_protocol: "icmp", from_port: -1, to_port: -1 }, { cidr_ipv4: ["local.vpc_cidr"] }),
      vm("blue", "vm-blue", "t4g.nano", "aws_subnet.private[0]", ["aws_security_group.web"], "blue_cloud_init"),
      vm("green", "vm-green", "t4g.nano", "aws_subnet.private[1]", ["aws_security_group.web"], "green_cloud_init"),
      vm("client", "vm-client", "t4g.nano", "aws_subnet.inspected", ["aws_security_group.client"], "cloud_init"),
      vm("appliance", "vm-appliance", "t4g.small", "aws_subnet.appliance", ["aws_security_group.appliance"], "appliance_cloud_init"),
    ],
  };
};
