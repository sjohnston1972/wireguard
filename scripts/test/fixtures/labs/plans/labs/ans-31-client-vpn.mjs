// scripts/test/fixtures/labs/plans/labs/ans-31-client-vpn.mjs
//
// Plain English: lab ans-31's first-deploy plan, as `terraform show -json`
// prints it (realistic.mjs adds what the providers compute): the template
// network, then certs.tf (the tls provider's three keys, the CA, the two
// certificate requests and the two locally signed certificates, and the ACM
// import of the server certificate), cvpn.tf (the endpoint's security group
// and its egress rule, the Client VPN endpoint, its one target network
// association and its one authorisation rule) and compute.tf (vm-target and
// its security group with seven rules). The keys and certificates are
// computed, so every attribute that carries one is unknown at plan and
// reaches its consumer by reference (ruling P20).

import { AWS_PROVIDER_CONFIG, GATEWAY_CIDR, al2023Instance, awsData, cidrsubnet, ctxAws, ref, tagged, templateResources } from "../common-aws.mjs";

export default () => {
  const c = ctxAws("ans-31-client-vpn", "31");
  const id = c.id;
  const prefix = "a31k3x9q";
  const clientCidr = cidrsubnet(c.address, 4, 15);
  const KEY = (n) => ({ address: `tls_private_key.${n}`, values: { algorithm: "RSA", rsa_bits: 2048 }, refs: {} });
  const request = (n, subject, extra = {}) => ({
    address: `tls_cert_request.${n}`,
    values: { subject: [subject], ...(extra.values ?? {}) },
    unknown: ["private_key_pem"],
    refs: { private_key_pem: ref(`tls_private_key.${n}`, "private_key_pem"), ...(extra.refs ?? {}) },
  });
  const signed = (n, uses) => ({
    address: `tls_locally_signed_cert.${n}`,
    values: { validity_period_hours: 48, allowed_uses: uses },
    unknown: ["cert_request_pem", "ca_private_key_pem", "ca_cert_pem"],
    refs: {
      cert_request_pem: ref(`tls_cert_request.${n}`, "cert_request_pem"),
      ca_private_key_pem: ref("tls_private_key.ca", "private_key_pem"),
      ca_cert_pem: ref("tls_self_signed_cert.ca", "cert_pem"),
    },
  });
  const rule = (kind, key, values, refs = {}, unknown = []) => ({
    address: `aws_vpc_security_group_${kind}_rule.${key}`,
    values: tagged(c, values),
    unknown: ["security_group_id", ...unknown],
    refs: { security_group_id: ref(kind === "egress" && key === "cvpn_to_lab" ? "aws_security_group.cvpn" : "aws_security_group.target", "id"), ...refs },
  });
  const tcp = (port) => ({ ip_protocol: "tcp", from_port: port, to_port: port });
  const fromCvpn = (key, values) => rule("ingress", key, values, { referenced_security_group_id: ref("aws_security_group.cvpn", "id") }, ["referenced_security_group_id"]);
  const target = al2023Instance(c, { key: "target", name: "vm-target", type: "t4g.nano", sgs: ["aws_security_group.target"] });
  target.refs.user_data = ["local.target_cloud_init"];
  const ENDPOINT = "aws_ec2_client_vpn_endpoint.lab";
  return {
    lab: id,
    variables: c.variables,
    providers: ["aws", "tls"],
    providerConfig: AWS_PROVIDER_CONFIG,
    data: awsData(),
    resources: [
      ...templateResources(c),
      // certs.tf
      KEY("ca"),
      KEY("server"),
      KEY("client"),
      {
        address: "tls_self_signed_cert.ca",
        values: { is_ca_certificate: true, validity_period_hours: 48, allowed_uses: ["cert_signing", "crl_signing"], subject: [{ common_name: "cloudlabs ans-31 CA", organization: "cloudlabs" }] },
        unknown: ["private_key_pem"],
        refs: { private_key_pem: ref("tls_private_key.ca", "private_key_pem") },
      },
      request("server", { common_name: `server.${prefix}.internal`, organization: "cloudlabs" }, {
        values: { dns_names: [`server.${prefix}.internal`] },
        refs: { dns_names: ["var.name_prefix"], "subject.0.common_name": ["var.name_prefix"] },
      }),
      signed("server", ["server_auth", "digital_signature", "key_encipherment"]),
      request("client", { common_name: `client.${prefix}.internal`, organization: "cloudlabs" }, { refs: { "subject.0.common_name": ["var.name_prefix"] } }),
      signed("client", ["client_auth", "digital_signature"]),
      {
        address: "aws_acm_certificate.server",
        values: tagged(c, { tags: { Name: "cert-cvpn-server" } }),
        unknown: ["private_key", "certificate_body", "certificate_chain"],
        sensitive: ["private_key"],
        refs: {
          private_key: ref("tls_private_key.server", "private_key_pem"),
          certificate_body: ref("tls_locally_signed_cert.server", "cert_pem"),
          certificate_chain: ref("tls_self_signed_cert.ca", "cert_pem"),
        },
      },
      // cvpn.tf
      { address: "aws_security_group.cvpn", values: tagged(c, { name: "lab-cvpn", description: "Client VPN endpoint: out to vpc-lab only", tags: { Name: "sg-cvpn" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } },
      rule("egress", "cvpn_to_lab", { cidr_ipv4: c.vpcCidr, ip_protocol: "-1" }, { cidr_ipv4: ["local.vpc_cidr"] }),
      {
        address: ENDPOINT,
        values: tagged(c, {
          description: `lab-${id}`, client_cidr_block: clientCidr, split_tunnel: true, transport_protocol: "udp", vpn_port: 443,
          self_service_portal: "disabled", session_timeout_hours: 8,
          authentication_options: [{ type: "certificate-authentication" }],
          connection_log_options: [{ enabled: false }],
          tags: { Name: "cvpn-lab" },
        }),
        unknown: ["server_certificate_arn", "authentication_options.0.root_certificate_chain_arn", "vpc_id", "security_group_ids"],
        refs: {
          server_certificate_arn: ref("aws_acm_certificate.server", "arn"),
          "authentication_options.0.root_certificate_chain_arn": ref("aws_acm_certificate.server", "arn"),
          vpc_id: ref("aws_vpc.lab", "id"),
          security_group_ids: ref("aws_security_group.cvpn", "id"),
          client_cidr_block: ["local.client_cidr"],
          description: ["var.lab_id"],
        },
      },
      {
        address: "aws_ec2_client_vpn_network_association.lab",
        values: {},
        unknown: ["client_vpn_endpoint_id", "subnet_id"],
        refs: { client_vpn_endpoint_id: ref(ENDPOINT, "id"), subnet_id: ["aws_subnet.private[0].id", "aws_subnet.private[0]", "aws_subnet.private"] },
      },
      {
        address: "aws_ec2_client_vpn_authorization_rule.lab",
        values: { target_network_cidr: c.vpcCidr, authorize_all_groups: true, description: "every connected client may reach vpc-lab" },
        unknown: ["client_vpn_endpoint_id"],
        refs: { client_vpn_endpoint_id: ref(ENDPOINT, "id"), target_network_cidr: ["local.vpc_cidr"] },
      },
      // compute.tf
      { address: "aws_security_group.target", values: tagged(c, { name: "lab-target", description: "vm-target: SSH, HTTP and ping over Client VPN, SSH from the Instance Connect Endpoint, SSH and HTTP from the gateway", tags: { Name: "sg-target" } }), unknown: ["vpc_id"], refs: { vpc_id: ref("aws_vpc.lab", "id") } },
      fromCvpn("target_ssh_cvpn", tcp(22)),
      fromCvpn("target_http_cvpn", tcp(80)),
      fromCvpn("target_ping_cvpn", { ip_protocol: "icmp", from_port: -1, to_port: -1 }),
      rule("ingress", "target_ssh_eice", tcp(22), { referenced_security_group_id: ref("aws_security_group.eice", "id") }, ["referenced_security_group_id"]),
      rule("ingress", "target_ssh_gateway", { cidr_ipv4: GATEWAY_CIDR, ...tcp(22) }, { cidr_ipv4: ["var.gateway_cidr"] }),
      rule("ingress", "target_http_gateway", { cidr_ipv4: GATEWAY_CIDR, ...tcp(80) }, { cidr_ipv4: ["var.gateway_cidr"] }),
      rule("egress", "target_all", { cidr_ipv4: "0.0.0.0/0", ip_protocol: "-1" }),
      target,
    ],
  };
};
