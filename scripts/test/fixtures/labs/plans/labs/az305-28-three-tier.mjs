// scripts/test/fixtures/labs/plans/labs/az305-28-three-tier.mjs
//
// Plain English: lab 28's first-deploy plan, written out from
// labs/az305-28-three-tier/terraform/main.tf with a real session's values
// (slot 1, uksouth, prefix l28k3x9q), as `terraform show -json` prints it
// (realistic.mjs adds what azurerm 4.81.0 computes, the schema's sensitive
// attributes and the unset optional-computed blocks). Names, addresses, the
// container commands (file() of the lab's scripts, known at plan) and the
// environment's infrastructure group are known; every id, the server's FQDN,
// the Front Door profile's resource_guid and the web tier's ingress FQDN are
// not. Lists holding one unknown id are unknown as a whole, as lab 23's real
// plan printed them. The app tier's secret block (its value is the sensitive
// admin_password) is sensitive as a whole, as the first release test's plan
// printed it (realistic.mjs's SENSITIVE_BLOCKS); so are a Standard WAF
// policy's unset cookie lifetimes unknown (PLAN_DEFAULTS: Premium only).

import { readFileSync } from "node:fs";
import { ctx, IN_RG, ref, REGION, rgResource } from "../common.mjs";

const TF = new URL("../../../../../../labs/az305-28-three-tier/terraform/", import.meta.url);
const script = (f) => readFileSync(new URL(f, TF), "utf8");
const PY = "mcr.microsoft.com/azurelinux/base/python:3.12";

export default () => {
  const c = ctx("az305-28-three-tier", "28");
  const inRg = { resource_group_name: IN_RG.resource_group_name };
  const zone = "privatelink.database.windows.net";
  const server = "azurerm_mssql_server.lab";
  const env = "azurerm_container_app_environment.lab";
  const afd = "azurerm_cdn_frontdoor_profile.lab";
  const og = "azurerm_cdn_frontdoor_origin_group.lab";
  const fqdn = ref(server, "fully_qualified_domain_name");
  const ingress = (external, insecure) => [{ external_enabled: external, allow_insecure_connections: insecure, target_port: 8080, traffic_weight: [{ latest_revision: true, percentage: 100 }] }];
  const shared = [{ name: "shared", path: "/shared" }];
  /** azurerm_container_app.web.ingress[0].fqdn, as Terraform lists its references: every step of the traversal, longest first. */
  const webFqdn = ["azurerm_container_app.web.ingress[0].fqdn", "azurerm_container_app.web.ingress[0]", "azurerm_container_app.web.ingress", "azurerm_container_app.web"];

  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      // Network: the environment's subnet and the private endpoint's.
      { address: "azurerm_virtual_network.lab", values: { name: "vnet-lab", resource_group_name: c.rg, location: REGION, address_space: ["10.64.64.0/20"], tags: c.tags }, refs: { ...IN_RG, address_space: ["local.vnet_cidr"] } },
      {
        address: "azurerm_subnet.apps",
        values: {
          name: "snet-apps",
          resource_group_name: c.rg,
          virtual_network_name: "vnet-lab",
          address_prefixes: ["10.64.64.0/24"],
          default_outbound_access_enabled: true,
          delegation: [{ name: "containerapps", service_delegation: [{ name: "Microsoft.App/environments", actions: ["Microsoft.Network/virtualNetworks/subnets/join/action"] }] }],
        },
        refs: { ...inRg, virtual_network_name: ref("azurerm_virtual_network.lab", "name"), address_prefixes: ["local.apps_cidr"] },
      },
      {
        address: "azurerm_subnet.endpoints",
        values: { name: "snet-pe", resource_group_name: c.rg, virtual_network_name: "vnet-lab", address_prefixes: ["10.64.65.0/24"], default_outbound_access_enabled: false },
        refs: { ...inRg, virtual_network_name: ref("azurerm_virtual_network.lab", "name"), address_prefixes: ["local.endpoints_cidr"] },
      },
      // Data tier: the server (public network access off), appdb (Basic), private DNS and the endpoint.
      {
        address: server,
        values: {
          name: `${c.prefix}-sql`,
          resource_group_name: c.rg,
          location: REGION,
          version: "12.0",
          administrator_login: "labadmin",
          administrator_login_password: "(the session's admin password)",
          minimum_tls_version: "1.2",
          public_network_access_enabled: false,
          tags: c.tags,
        },
        refs: { ...IN_RG, name: ["var.name_prefix"], administrator_login_password: ["var.admin_password"] },
        sensitive: ["administrator_login_password"],
      },
      {
        address: "azurerm_mssql_database.app",
        values: { name: "appdb", sku_name: "Basic", tags: c.tags },
        unknown: ["server_id"],
        refs: { server_id: ref(server, "id"), tags: ["var.tags"] },
      },
      { address: "azurerm_private_dns_zone.sql", values: { name: zone, resource_group_name: c.rg, tags: c.tags }, refs: { ...inRg, tags: ["var.tags"] } },
      {
        address: "azurerm_private_dns_zone_virtual_network_link.lab",
        values: { name: "link-vnet-lab", resource_group_name: c.rg, private_dns_zone_name: zone, registration_enabled: false, tags: c.tags },
        unknown: ["virtual_network_id"],
        refs: { ...inRg, private_dns_zone_name: ref("azurerm_private_dns_zone.sql", "name"), virtual_network_id: ref("azurerm_virtual_network.lab", "id"), tags: ["var.tags"] },
      },
      {
        address: "azurerm_private_endpoint.sql",
        values: {
          name: `pe-${c.prefix}-sql`,
          resource_group_name: c.rg,
          location: REGION,
          custom_network_interface_name: `nic-pe-${c.prefix}-sql`,
          tags: c.tags,
          private_service_connection: [{ name: "psc-sql", private_connection_resource_id: "(unknown)", subresource_names: ["sqlServer"], is_manual_connection: false }],
          private_dns_zone_group: [{ name: "sql" }],
        },
        unknown: ["subnet_id", "private_service_connection.0.private_connection_resource_id", "private_dns_zone_group.0.private_dns_zone_ids"],
        refs: {
          ...IN_RG,
          name: ref(server, "name"),
          custom_network_interface_name: ref(server, "name"),
          subnet_id: ref("azurerm_subnet.endpoints", "id"),
          "private_service_connection.0.private_connection_resource_id": ref(server, "id"),
          "private_dns_zone_group.0.private_dns_zone_ids": ref("azurerm_private_dns_zone.sql", "id"),
        },
      },
      // The environment: workload profiles (Consumption only) in snet-apps, its own group rg-lab-<id>-infra.
      {
        address: env,
        values: {
          name: "cae-lab",
          resource_group_name: c.rg,
          location: REGION,
          infrastructure_resource_group_name: `${c.rg}-infra`,
          internal_load_balancer_enabled: false,
          zone_redundancy_enabled: false,
          tags: c.tags,
          workload_profile: [{ name: "Consumption", workload_profile_type: "Consumption" }],
        },
        unknown: ["infrastructure_subnet_id"],
        refs: { ...IN_RG, infrastructure_subnet_id: ref("azurerm_subnet.apps", "id"), infrastructure_resource_group_name: ["var.resource_group_name"] },
      },
      // App tier: internal ingress, the api container and the sqltools sidecar, the password as a secret.
      {
        address: "azurerm_container_app.app",
        values: {
          name: "ca-app",
          resource_group_name: c.rg,
          revision_mode: "Single",
          workload_profile_name: "Consumption",
          tags: c.tags,
          secret: [{ name: "sql-password", value: "(the session's admin password)" }],
          template: [
            {
              min_replicas: 1,
              max_replicas: 1,
              volume: [{ name: "shared", storage_type: "EmptyDir" }],
              container: [
                { name: "api", image: PY, cpu: 0.25, memory: "0.5Gi", command: ["python3", "-c", script("app.py")], env: [{ name: "SQL_SERVER" }], volume_mounts: shared },
                {
                  name: "sqltools",
                  image: "mcr.microsoft.com/mssql/server:2022-latest",
                  cpu: 0.25,
                  memory: "0.5Gi",
                  command: ["/bin/bash", "-c", script("sqltools.sh")],
                  env: [{ name: "SQLCMDSERVER" }, { name: "SQLCMDUSER", value: "labadmin" }, { name: "SQLCMDDBNAME", value: "appdb" }, { name: "SQLCMDPASSWORD", secret_name: "sql-password" }],
                  volume_mounts: shared,
                },
              ],
            },
          ],
          ingress: ingress(false, true),
        },
        unknown: ["container_app_environment_id", "template.0.container.0.env.0.value", "template.0.container.1.env.0.value"],
        refs: {
          resource_group_name: IN_RG.resource_group_name,
          tags: ["var.tags"],
          container_app_environment_id: ref(env, "id"),
          "secret.0.value": ["var.admin_password"],
          "template.0.container.0.command": ["path.module"],
          "template.0.container.0.env.0.value": fqdn,
          "template.0.container.1.command": ["path.module"],
          "template.0.container.1.env.0.value": fqdn,
        },
      },
      // Web tier: public HTTPS ingress, scales to zero, accepts only this profile's X-Azure-FDID.
      {
        address: "azurerm_container_app.web",
        values: {
          name: "ca-web",
          resource_group_name: c.rg,
          revision_mode: "Single",
          workload_profile_name: "Consumption",
          tags: c.tags,
          template: [
            {
              min_replicas: 0,
              max_replicas: 1,
              container: [{ name: "web", image: PY, cpu: 0.25, memory: "0.5Gi", command: ["python3", "-c", script("web.py")], env: [{ name: "FRONT_DOOR_ID" }, { name: "APP_URL", value: "http://ca-app" }] }],
            },
          ],
          ingress: ingress(true, false),
        },
        unknown: ["container_app_environment_id", "template.0.container.0.env.0.value"],
        refs: {
          resource_group_name: IN_RG.resource_group_name,
          tags: ["var.tags"],
          container_app_environment_id: ref(env, "id"),
          "template.0.container.0.command": ["path.module"],
          "template.0.container.0.env.0.value": ref(afd, "resource_guid"),
        },
      },
      // Front Door Standard (global, in rg-lab-<id>).
      { address: afd, values: { name: "afd-lab", resource_group_name: c.rg, sku_name: "Standard_AzureFrontDoor", tags: c.tags }, refs: { ...inRg, tags: ["var.tags"] } },
      {
        address: "azurerm_cdn_frontdoor_endpoint.lab",
        values: { name: `${c.prefix}-afd`, tags: c.tags },
        unknown: ["cdn_frontdoor_profile_id"],
        refs: { name: ["var.name_prefix"], cdn_frontdoor_profile_id: ref(afd, "id"), tags: ["var.tags"] },
      },
      {
        address: og,
        values: { name: "og-web", session_affinity_enabled: false, load_balancing: [{ sample_size: 4, successful_samples_required: 3 }] },
        unknown: ["cdn_frontdoor_profile_id"],
        refs: { cdn_frontdoor_profile_id: ref(afd, "id") },
      },
      {
        address: "azurerm_cdn_frontdoor_origin.web",
        values: { name: "origin-web", enabled: true, http_port: 80, https_port: 443, priority: 1, weight: 1000, certificate_name_check_enabled: true },
        unknown: ["cdn_frontdoor_origin_group_id", "host_name", "origin_host_header"],
        refs: { cdn_frontdoor_origin_group_id: ref(og, "id"), host_name: webFqdn, origin_host_header: webFqdn },
      },
      {
        address: "azurerm_cdn_frontdoor_route.lab",
        values: { name: "route-all", patterns_to_match: ["/*"], supported_protocols: ["Http", "Https"], forwarding_protocol: "HttpsOnly", https_redirect_enabled: true, link_to_default_domain: true },
        unknown: ["cdn_frontdoor_endpoint_id", "cdn_frontdoor_origin_group_id", "cdn_frontdoor_origin_ids"],
        refs: {
          cdn_frontdoor_endpoint_id: ref("azurerm_cdn_frontdoor_endpoint.lab", "id"),
          cdn_frontdoor_origin_group_id: ref(og, "id"),
          cdn_frontdoor_origin_ids: ref("azurerm_cdn_frontdoor_origin.web", "id"),
        },
      },
      // The WAF policy (Standard: custom rules only) and the security policy tying it to the endpoint.
      {
        address: "azurerm_cdn_frontdoor_firewall_policy.lab",
        values: {
          name: "waflab",
          resource_group_name: c.rg,
          sku_name: "Standard_AzureFrontDoor",
          enabled: true,
          mode: "Prevention",
          custom_block_response_status_code: 403,
          custom_block_response_body: Buffer.from("Blocked by the lab's WAF policy.\n").toString("base64"),
          tags: c.tags,
          custom_rule: [
            { name: "BlockAdminPath", enabled: true, priority: 10, type: "MatchRule", action: "Block", match_condition: [{ match_variable: "RequestUri", operator: "Contains", match_values: ["/admin"], transforms: ["Lowercase"] }] },
            {
              name: "RateLimitPerClient",
              enabled: true,
              priority: 20,
              type: "RateLimitRule",
              action: "Block",
              rate_limit_duration_in_minutes: 1,
              rate_limit_threshold: 100,
              match_condition: [{ match_variable: "RequestUri", operator: "Contains", match_values: ["/"] }],
            },
          ],
        },
        refs: { ...inRg, tags: ["var.tags"] },
      },
      {
        address: "azurerm_cdn_frontdoor_security_policy.lab",
        values: { name: "sp-afd", security_policies: [{ firewall: [{ association: [{ patterns_to_match: ["/*"], domain: [{}] }] }] }] },
        unknown: ["cdn_frontdoor_profile_id", "security_policies.0.firewall.0.cdn_frontdoor_firewall_policy_id", "security_policies.0.firewall.0.association.0.domain.0.cdn_frontdoor_domain_id"],
        refs: {
          cdn_frontdoor_profile_id: ref(afd, "id"),
          "security_policies.0.firewall.0.cdn_frontdoor_firewall_policy_id": ref("azurerm_cdn_frontdoor_firewall_policy.lab", "id"),
          "security_policies.0.firewall.0.association.0.domain.0.cdn_frontdoor_domain_id": ref("azurerm_cdn_frontdoor_endpoint.lab", "id"),
        },
      },
    ],
  };
};
