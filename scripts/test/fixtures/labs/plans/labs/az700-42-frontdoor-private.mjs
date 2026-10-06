// scripts/test/fixtures/labs/plans/labs/az700-42-frontdoor-private.mjs
//
// Plain English: lab 42's first-deploy plan, written out from
// labs/az700-42-frontdoor-private/terraform/main.tf with a real session's
// values at slot 31 (10.71.192.0/18): vnet-app 10.71.192.0/20, snet-web
// 10.71.192.0/24 with lb-int's frontend at 10.71.192.10 (Front Door's origin
// host, known at plan), snet-pls 10.71.193.0/24. The Private Link service
// points at lb-int's frontend_ip_configuration[0], which Terraform lists as
// every step of the traversal; every Front Door id, the origin's Private
// Link target and the security policy's domain are known only after apply.

import { ctx, IN_RG, linuxVm, ref, REGION, rgResource } from "../common.mjs";

export default () => {
  const c = ctx("az700-42-frontdoor-private", "42", { slot: 31 });
  const inRg = { resource_group_name: IN_RG.resource_group_name };
  const afd = "azurerm_cdn_frontdoor_profile.lab";
  const og = "azurerm_cdn_frontdoor_origin_group.lab";
  const rs = "azurerm_cdn_frontdoor_rule_set.lab";
  const onLb = (address, values, more = [], moreRefs = {}) => ({ address, values, unknown: ["loadbalancer_id", ...more], refs: { loadbalancer_id: ref("azurerm_lb.int", "id"), ...moreRefs } });
  const rule = (key, values) => ({ address: `azurerm_cdn_frontdoor_rule.${key}`, values, unknown: ["cdn_frontdoor_rule_set_id"], refs: { cdn_frontdoor_rule_set_id: ref(rs, "id") } });
  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      { address: "azurerm_virtual_network.app", values: { name: "vnet-app", resource_group_name: c.rg, location: REGION, address_space: ["10.71.192.0/20"], tags: c.tags }, refs: { ...IN_RG, address_space: ["local.app_cidr"] } },
      {
        address: "azurerm_subnet.web",
        values: { name: "snet-web", resource_group_name: c.rg, virtual_network_name: "vnet-app", address_prefixes: ["10.71.192.0/24"], default_outbound_access_enabled: false },
        refs: { ...inRg, virtual_network_name: ref("azurerm_virtual_network.app", "name"), address_prefixes: ["local.web_cidr"] },
      },
      {
        address: "azurerm_subnet.pls",
        values: { name: "snet-pls", resource_group_name: c.rg, virtual_network_name: "vnet-app", address_prefixes: ["10.71.193.0/24"], private_link_service_network_policies_enabled: false, default_outbound_access_enabled: false },
        refs: { ...inRg, virtual_network_name: ref("azurerm_virtual_network.app", "name"), address_prefixes: ["local.pls_cidr"] },
      },
      // custom_data: the cloud-init template with no values, known at plan.
      ...linuxVm(c, { name: "vm-web", key: "web", subnet: "azurerm_subnet.web", customData: "I2Nsb3VkLWNvbmZpZwo= (cloud-init.yaml.tftpl)" }),

      // lb-int and pls-web.
      {
        address: "azurerm_lb.int",
        values: { name: "lb-int", resource_group_name: c.rg, location: REGION, sku: "Standard", tags: c.tags, frontend_ip_configuration: [{ name: "fe-int", private_ip_address_allocation: "Static", private_ip_address: "10.71.192.10" }] },
        unknown: ["frontend_ip_configuration.0.subnet_id"],
        refs: { ...IN_RG, "frontend_ip_configuration.0.subnet_id": ref("azurerm_subnet.web", "id"), "frontend_ip_configuration.0.private_ip_address": ["local.lb_ip"] },
      },
      onLb("azurerm_lb_backend_address_pool.int", { name: "pool-web" }),
      onLb("azurerm_lb_probe.int", { name: "probe-http", protocol: "Http", port: 80, request_path: "/" }),
      onLb("azurerm_lb_rule.int", { name: "rule-http-80", protocol: "Tcp", frontend_port: 80, backend_port: 80, frontend_ip_configuration_name: "fe-int" }, ["backend_address_pool_ids", "probe_id"], {
        backend_address_pool_ids: ref("azurerm_lb_backend_address_pool.int", "id"),
        probe_id: ref("azurerm_lb_probe.int", "id"),
      }),
      {
        address: "azurerm_network_interface_backend_address_pool_association.web",
        values: { ip_configuration_name: "ipconfig1" },
        unknown: ["network_interface_id", "backend_address_pool_id"],
        refs: { network_interface_id: ref("azurerm_network_interface.web", "id"), backend_address_pool_id: ref("azurerm_lb_backend_address_pool.int", "id") },
      },
      {
        address: "azurerm_private_link_service.web",
        values: { name: "pls-web", resource_group_name: c.rg, location: REGION, tags: c.tags, nat_ip_configuration: [{ name: "nat-pls", primary: true }] },
        unknown: ["load_balancer_frontend_ip_configuration_ids", "nat_ip_configuration.0.subnet_id"],
        refs: {
          ...IN_RG,
          load_balancer_frontend_ip_configuration_ids: ["azurerm_lb.int.frontend_ip_configuration[0].id", "azurerm_lb.int.frontend_ip_configuration[0]", "azurerm_lb.int.frontend_ip_configuration", "azurerm_lb.int"],
          "nat_ip_configuration.0.subnet_id": ref("azurerm_subnet.pls", "id"),
        },
      },

      // Front Door Premium.
      { address: afd, values: { name: "afd-premium", resource_group_name: c.rg, sku_name: "Premium_AzureFrontDoor", tags: c.tags }, refs: { ...inRg, tags: ["var.tags"] } },
      {
        address: "azurerm_cdn_frontdoor_endpoint.lab",
        values: { name: `${c.prefix}-afd`, tags: c.tags },
        unknown: ["cdn_frontdoor_profile_id"],
        refs: { name: ["var.name_prefix"], cdn_frontdoor_profile_id: ref(afd, "id"), tags: ["var.tags"] },
      },
      {
        address: og,
        values: { name: "og-web", session_affinity_enabled: false, health_probe: [{ protocol: "Http", path: "/", request_type: "HEAD", interval_in_seconds: 100 }], load_balancing: [{ sample_size: 4, successful_samples_required: 3 }] },
        unknown: ["cdn_frontdoor_profile_id"],
        refs: { cdn_frontdoor_profile_id: ref(afd, "id") },
      },
      {
        address: "azurerm_cdn_frontdoor_origin.web",
        values: {
          name: "origin-lb-int",
          enabled: true,
          host_name: "10.71.192.10",
          origin_host_header: "10.71.192.10",
          http_port: 80,
          https_port: 443,
          priority: 1,
          weight: 1000,
          certificate_name_check_enabled: true,
          private_link: [{ location: REGION, request_message: "Front Door lab 42 asks to reach pls-web" }],
        },
        unknown: ["cdn_frontdoor_origin_group_id", "private_link.0.private_link_target_id"],
        refs: {
          cdn_frontdoor_origin_group_id: ref(og, "id"),
          host_name: ["local.lb_ip"],
          origin_host_header: ["local.lb_ip"],
          "private_link.0.private_link_target_id": ref("azurerm_private_link_service.web", "id"),
          "private_link.0.location": ["var.region"],
        },
      },

      // The rule set and its three rules.
      { address: rs, values: { name: "ruleslab42" }, unknown: ["cdn_frontdoor_profile_id"], refs: { cdn_frontdoor_profile_id: ref(afd, "id") } },
      rule("redirect_old", {
        name: "redirectold",
        order: 1,
        behavior_on_match: "Stop",
        conditions: [{ url_path_condition: [{ operator: "Equal", match_values: ["old"], transforms: ["Lowercase"] }] }],
        actions: [{ url_redirect_action: [{ redirect_type: "Moved", redirect_protocol: "MatchRequest", destination_hostname: "", destination_path: "/" }] }],
      }),
      rule("header", {
        name: "addheader",
        order: 2,
        behavior_on_match: "Continue",
        actions: [{ response_header_action: [{ header_action: "Overwrite", header_name: "X-Lab", value: "42" }] }],
      }),
      rule("cache_static", {
        name: "cachestatic",
        order: 3,
        behavior_on_match: "Continue",
        conditions: [{ url_path_condition: [{ operator: "BeginsWith", match_values: ["static/"] }] }],
        actions: [{ route_configuration_override_action: [{ cache_behavior: "OverrideAlways", cache_duration: "01:00:00", query_string_caching_behavior: "IgnoreQueryString", compression_enabled: true }] }],
      }),
      {
        address: "azurerm_cdn_frontdoor_route.lab",
        values: {
          name: "route-all",
          patterns_to_match: ["/*"],
          supported_protocols: ["Http", "Https"],
          forwarding_protocol: "HttpOnly",
          https_redirect_enabled: true,
          link_to_default_domain: true,
          cache: [{ query_string_caching_behavior: "IgnoreQueryString", compression_enabled: true, content_types_to_compress: ["text/html", "text/plain", "text/css", "application/javascript"] }],
        },
        unknown: ["cdn_frontdoor_endpoint_id", "cdn_frontdoor_origin_group_id", "cdn_frontdoor_origin_ids", "cdn_frontdoor_rule_set_ids"],
        refs: {
          cdn_frontdoor_endpoint_id: ref("azurerm_cdn_frontdoor_endpoint.lab", "id"),
          cdn_frontdoor_origin_group_id: ref(og, "id"),
          cdn_frontdoor_origin_ids: ref("azurerm_cdn_frontdoor_origin.web", "id"),
          cdn_frontdoor_rule_set_ids: ref(rs, "id"),
        },
      },

      // The WAF policy and the security policy.
      {
        address: "azurerm_cdn_frontdoor_firewall_policy.lab",
        values: {
          name: "wafpremium",
          resource_group_name: c.rg,
          sku_name: "Premium_AzureFrontDoor",
          enabled: true,
          mode: "Prevention",
          tags: c.tags,
          custom_rule: [
            {
              name: "RateLimitPerClient",
              enabled: true,
              priority: 10,
              type: "RateLimitRule",
              action: "Block",
              rate_limit_duration_in_minutes: 1,
              rate_limit_threshold: 100,
              match_condition: [{ match_variable: "RequestUri", operator: "Contains", match_values: ["/"] }],
            },
          ],
          managed_rule: [
            { type: "Microsoft_DefaultRuleSet", version: "2.1", action: "Block" },
            { type: "Microsoft_BotManagerRuleSet", version: "1.1", action: "Block" },
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
