// scripts/test/fixtures/labs/plans/labs/az700-41-appgw-waf.mjs
//
// Plain English: lab 41's first-deploy plan, written out from
// labs/az700-41-appgw-waf/terraform/main.tf with a real session's values at
// slot 31 (10.71.192.0/18): vnet-hub 10.71.192.0/20, snet-agw 10.71.192.0/24
// with the gateway's private frontend at 10.71.192.10, snet-web
// 10.71.193.0/24. The vault's tenant and the pipeline's access policy come
// from the client config read at plan; the gateway identity's principal,
// the certificate's secret id, the VMs' addresses and every id are known
// only after apply. Two VMs, written out (no count).

import { ctx, IN_RG, linuxVm, ref, REGION, rgResource, SUB, TENANT } from "../common.mjs";

const PIPELINE_OBJECT_ID = "6a1f2e3d-4c5b-4a69-8f7e-0d1c2b3a4f5e";
const PIPELINE_CLIENT_ID = "0b9c8d7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e";
const CLIENT = "data.azurerm_client_config.current";

export default () => {
  const c = ctx("az700-41-appgw-waf", "41", { slot: 31 });
  const inRg = { resource_group_name: IN_RG.resource_group_name };
  const kv = "azurerm_key_vault.lab";
  const uai = "azurerm_user_assigned_identity.agw";
  const subnet = (key, cidr, outbound) => ({
    address: `azurerm_subnet.${key}`,
    values: { name: `snet-${key}`, resource_group_name: c.rg, virtual_network_name: "vnet-hub", address_prefixes: [cidr], default_outbound_access_enabled: outbound },
    refs: { ...inRg, virtual_network_name: ref("azurerm_virtual_network.hub", "name"), address_prefixes: [`local.${key}_cidr`] },
  });
  const rule = (key, v) => ({
    address: `azurerm_network_security_rule.${key}`,
    values: { resource_group_name: c.rg, network_security_group_name: "nsg-agw", direction: "Inbound", access: "Allow", protocol: "Tcp", source_port_range: "*", destination_address_prefix: "*", ...v },
    refs: { ...inRg, network_security_group_name: ref("azurerm_network_security_group.agw", "name") },
  });
  const vm = (n) => linuxVm(c, { name: `vm-web${n}`, key: `web${n}`, subnet: "azurerm_subnet.web", customData: `I2Nsb3VkLWNvbmZpZwo= (cloud-init.yaml.tftpl, vm-web${n})` });
  return {
    lab: c.id,
    variables: c.variables,
    data: [
      {
        address: CLIENT,
        values: { id: `clientConfigs/clientId=${PIPELINE_CLIENT_ID};objectId=${PIPELINE_OBJECT_ID};subscriptionId=${SUB};tenantId=${TENANT}`, client_id: PIPELINE_CLIENT_ID, object_id: PIPELINE_OBJECT_ID, subscription_id: SUB, tenant_id: TENANT },
      },
    ],
    resources: [
      rgResource(c),
      { address: "azurerm_virtual_network.hub", values: { name: "vnet-hub", resource_group_name: c.rg, location: REGION, address_space: ["10.71.192.0/20"], tags: c.tags }, refs: { ...IN_RG, address_space: ["local.hub_cidr"] } },
      subnet("agw", "10.71.192.0/24", true),
      subnet("web", "10.71.193.0/24", false),
      { address: "azurerm_network_security_group.agw", values: { name: "nsg-agw", resource_group_name: c.rg, location: REGION, tags: c.tags }, refs: IN_RG },
      rule("agw_manager", { name: "allow-gateway-manager", priority: 100, destination_port_range: "65200-65535", source_address_prefix: "GatewayManager" }),
      rule("agw_web", { name: "allow-web-from-vnet", priority: 110, destination_port_ranges: ["80", "443"], source_address_prefix: "VirtualNetwork" }),
      {
        address: "azurerm_subnet_network_security_group_association.agw",
        values: {},
        unknown: ["subnet_id", "network_security_group_id"],
        refs: { subnet_id: ref("azurerm_subnet.agw", "id"), network_security_group_id: ref("azurerm_network_security_group.agw", "id") },
      },
      ...vm(1),
      ...vm(2),

      // Key Vault, access policies and the self-signed certificate.
      {
        address: kv,
        values: {
          name: `${c.prefix}kv`,
          resource_group_name: c.rg,
          location: REGION,
          tenant_id: TENANT,
          sku_name: "standard",
          rbac_authorization_enabled: false,
          public_network_access_enabled: true,
          soft_delete_retention_days: 7,
          purge_protection_enabled: false,
          tags: c.tags,
        },
        refs: { ...IN_RG, name: ["var.name_prefix"], tenant_id: ref(CLIENT, "tenant_id") },
      },
      {
        address: "azurerm_key_vault_access_policy.pipeline",
        values: { tenant_id: TENANT, object_id: PIPELINE_OBJECT_ID, certificate_permissions: ["Create", "Delete", "Get", "List", "Purge"], secret_permissions: ["Get"] },
        unknown: ["key_vault_id"],
        refs: { key_vault_id: ref(kv, "id"), tenant_id: ref(CLIENT, "tenant_id"), object_id: ref(CLIENT, "object_id") },
      },
      { address: uai, values: { name: `id-${c.prefix}-agw`, resource_group_name: c.rg, location: REGION, tags: c.tags }, refs: { ...IN_RG, name: ["var.name_prefix"] } },
      {
        address: "azurerm_key_vault_access_policy.agw",
        values: { tenant_id: TENANT, secret_permissions: ["Get"] },
        unknown: ["key_vault_id", "object_id"],
        refs: { key_vault_id: ref(kv, "id"), tenant_id: ref(CLIENT, "tenant_id"), object_id: ref(uai, "principal_id") },
      },
      {
        address: "azurerm_key_vault_certificate.app",
        values: {
          name: "cert-app",
          tags: c.tags,
          certificate_policy: [
            {
              issuer_parameters: [{ name: "Self" }],
              key_properties: [{ exportable: true, key_size: 2048, key_type: "RSA", reuse_key: true }],
              lifetime_action: [{ action: [{ action_type: "AutoRenew" }], trigger: [{ days_before_expiry: 30 }] }],
              secret_properties: [{ content_type: "application/x-pkcs12" }],
              x509_certificate_properties: [
                {
                  subject: "CN=app.lab41.internal",
                  validity_in_months: 12,
                  key_usage: ["digitalSignature", "keyEncipherment"],
                  extended_key_usage: ["1.3.6.1.5.5.7.3.1"],
                  subject_alternative_names: [{ dns_names: ["app.lab41.internal"] }],
                },
              ],
            },
          ],
        },
        unknown: ["key_vault_id"],
        refs: { key_vault_id: ref(kv, "id"), tags: ["var.tags"] },
      },

      // The WAF policy.
      {
        address: "azurerm_web_application_firewall_policy.hub",
        values: {
          name: "waf-hub",
          resource_group_name: c.rg,
          location: REGION,
          tags: c.tags,
          policy_settings: [{ enabled: true, mode: "Prevention", request_body_check: true, max_request_body_size_in_kb: 128, file_upload_limit_in_mb: 100 }],
          managed_rules: [{ managed_rule_set: [{ type: "Microsoft_DefaultRuleSet", version: "2.1" }] }],
          custom_rules: [
            {
              name: "BlockAttackQuery",
              priority: 10,
              rule_type: "MatchRule",
              action: "Block",
              match_conditions: [{ match_variables: [{ variable_name: "QueryString" }], operator: "Contains", match_values: ["attack=1"], transforms: ["Lowercase"] }],
            },
          ],
        },
        refs: IN_RG,
      },

      // The gateway and the public IP it must own.
      { address: "azurerm_public_ip.agw", values: { name: "pip-agw", resource_group_name: c.rg, location: REGION, allocation_method: "Static", sku: "Standard", tags: c.tags }, refs: IN_RG },
      {
        address: "azurerm_application_gateway.hub",
        values: {
          name: "agw-hub",
          resource_group_name: c.rg,
          location: REGION,
          tags: c.tags,
          // capacity is unset (autoscale): azurerm leaves it null in the plan.
          sku: [{ name: "WAF_v2", tier: "WAF_v2", capacity: null }],
          autoscale_configuration: [{ min_capacity: 0, max_capacity: 2 }],
          identity: [{ type: "UserAssigned" }],
          gateway_ip_configuration: [{ name: "gateway-ip" }],
          frontend_port: [
            { name: "port-80", port: 80 },
            { name: "port-443", port: 443 },
          ],
          frontend_ip_configuration: [{ name: "fe-public" }, { name: "fe-private", private_ip_address_allocation: "Static", private_ip_address: "10.71.192.10" }],
          ssl_certificate: [{ name: "cert-app" }],
          backend_address_pool: [{ name: "pool-web" }],
          probe: [{ name: "probe-http", protocol: "Http", host: "127.0.0.1", path: "/", interval: 30, timeout: 30, unhealthy_threshold: 3 }],
          backend_http_settings: [{ name: "http-80", port: 80, protocol: "Http", cookie_based_affinity: "Disabled", request_timeout: 30, probe_name: "probe-http" }],
          http_listener: [
            { name: "listener-http", frontend_ip_configuration_name: "fe-private", frontend_port_name: "port-80", protocol: "Http" },
            { name: "listener-https", frontend_ip_configuration_name: "fe-private", frontend_port_name: "port-443", protocol: "Https", ssl_certificate_name: "cert-app" },
          ],
          redirect_configuration: [{ name: "http-to-https", redirect_type: "Permanent", target_listener_name: "listener-https", include_path: true, include_query_string: true }],
          rewrite_rule_set: [
            {
              name: "rw-headers",
              rewrite_rule: [
                { name: "add-x-lab", rule_sequence: 100, response_header_configuration: [{ header_name: "X-Lab", header_value: "41" }] },
                { name: "remove-server", rule_sequence: 110, response_header_configuration: [{ header_name: "Server", header_value: "" }] },
              ],
            },
          ],
          request_routing_rule: [
            { name: "rule-http-redirect", priority: 100, rule_type: "Basic", http_listener_name: "listener-http", redirect_configuration_name: "http-to-https" },
            { name: "rule-https", priority: 110, rule_type: "Basic", http_listener_name: "listener-https", backend_address_pool_name: "pool-web", backend_http_settings_name: "http-80", rewrite_rule_set_name: "rw-headers" },
          ],
          ssl_policy: [{ policy_type: "Predefined", policy_name: "AppGwSslPolicy20220101" }],
        },
        unknown: [
          "firewall_policy_id",
          "identity.0.identity_ids",
          "gateway_ip_configuration.0.subnet_id",
          "frontend_ip_configuration.0.public_ip_address_id",
          "frontend_ip_configuration.1.subnet_id",
          "ssl_certificate.0.key_vault_secret_id",
          "backend_address_pool.0.ip_addresses",
        ],
        refs: {
          ...IN_RG,
          firewall_policy_id: ref("azurerm_web_application_firewall_policy.hub", "id"),
          "identity.0.identity_ids": ref(uai, "id"),
          "gateway_ip_configuration.0.subnet_id": ref("azurerm_subnet.agw", "id"),
          "frontend_ip_configuration.0.public_ip_address_id": ref("azurerm_public_ip.agw", "id"),
          "frontend_ip_configuration.1.subnet_id": ref("azurerm_subnet.agw", "id"),
          "frontend_ip_configuration.1.private_ip_address": ["local.agw_ip"],
          "ssl_certificate.0.key_vault_secret_id": ref("azurerm_key_vault_certificate.app", "versionless_secret_id"),
          "backend_address_pool.0.ip_addresses": [...ref("azurerm_network_interface.web1", "private_ip_address"), ...ref("azurerm_network_interface.web2", "private_ip_address")],
        },
      },

      // app.lab41.internal.
      { address: "azurerm_private_dns_zone.lab", values: { name: "lab41.internal", resource_group_name: c.rg, tags: c.tags }, refs: { ...inRg, tags: ["var.tags"] } },
      {
        address: "azurerm_private_dns_a_record.app",
        values: { name: "app", zone_name: "lab41.internal", resource_group_name: c.rg, ttl: 300, records: ["10.71.192.10"], tags: c.tags },
        refs: { ...inRg, zone_name: ref("azurerm_private_dns_zone.lab", "name"), records: ["local.agw_ip"], tags: ["var.tags"] },
      },
      {
        address: "azurerm_private_dns_zone_virtual_network_link.hub",
        values: { name: "link-vnet-hub", resource_group_name: c.rg, private_dns_zone_name: "lab41.internal", registration_enabled: false, tags: c.tags },
        unknown: ["virtual_network_id"],
        refs: { ...inRg, private_dns_zone_name: ref("azurerm_private_dns_zone.lab", "name"), virtual_network_id: ref("azurerm_virtual_network.hub", "id"), tags: ["var.tags"] },
      },

      // Logs.
      {
        address: "azurerm_log_analytics_workspace.lab",
        values: { name: "log-agw", resource_group_name: c.rg, location: REGION, sku: "PerGB2018", retention_in_days: 30, daily_quota_gb: 0.05, tags: c.tags },
        refs: IN_RG,
      },
      {
        address: "azurerm_monitor_diagnostic_setting.agw",
        values: { name: "diag-agw", log_analytics_destination_type: "Dedicated", enabled_log: [{ category: "ApplicationGatewayAccessLog" }, { category: "ApplicationGatewayFirewallLog" }] },
        unknown: ["target_resource_id", "log_analytics_workspace_id"],
        refs: { target_resource_id: ref("azurerm_application_gateway.hub", "id"), log_analytics_workspace_id: ref("azurerm_log_analytics_workspace.lab", "id") },
      },
    ],
  };
};
