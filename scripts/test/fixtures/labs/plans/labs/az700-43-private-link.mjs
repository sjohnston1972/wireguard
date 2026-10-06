// scripts/test/fixtures/labs/plans/labs/az700-43-private-link.mjs
//
// Plain English: lab 43's first-deploy plan, written out from
// labs/az700-43-private-link/terraform/main.tf with a real session's values
// at slot 31 (10.71.192.0/18): vnet-provider 10.71.192.0/20 (snet-svc
// 10.71.192.0/24 with lb-svc at 10.71.192.10, snet-pls 10.71.193.0/24) and
// vnet-consumer 10.71.208.0/20 (snet-pe 10.71.208.0/24, snet-client
// 10.71.209.0/24). The subscription data source is read at plan, so the
// Private Link service's auto-approval and visibility lists are known (the
// subscription's GUID); every id the endpoints, the policy and the subnet
// point at is known only after apply.

import { ctx, IN_RG, linuxVm, ref, REGION, rgResource, SUB, TENANT } from "../common.mjs";

const SUBSCRIPTION = "data.azurerm_subscription.current";

export default () => {
  const c = ctx("az700-43-private-link", "43", { slot: 31 });
  const inRg = { resource_group_name: IN_RG.resource_group_name };
  const vnet = (key, cidr) => ({
    address: `azurerm_virtual_network.${key}`,
    values: { name: `vnet-${key}`, resource_group_name: c.rg, location: REGION, address_space: [cidr], tags: c.tags },
    refs: { ...IN_RG, address_space: [`local.${key}_cidr`] },
  });
  const subnet = (key, vnetKey, cidr, extra = {}, more = {}) => ({
    address: `azurerm_subnet.${key}`,
    values: { name: `snet-${key}`, resource_group_name: c.rg, virtual_network_name: `vnet-${vnetKey}`, address_prefixes: [cidr], ...extra },
    ...more,
    refs: { ...inRg, virtual_network_name: ref(`azurerm_virtual_network.${vnetKey}`, "name"), address_prefixes: [`local.${key}_cidr`], ...(more.refs ?? {}) },
  });
  const onLb = (address, values, more = [], moreRefs = {}) => ({ address, values, unknown: ["loadbalancer_id", ...more], refs: { loadbalancer_id: ref("azurerm_lb.svc", "id"), ...moreRefs } });
  const account = (key) => ({
    address: `azurerm_storage_account.${key}`,
    values: {
      name: `${c.prefix}${key}`,
      resource_group_name: c.rg,
      location: REGION,
      account_kind: "StorageV2",
      account_tier: "Standard",
      account_replication_type: "LRS",
      min_tls_version: "TLS1_2",
      https_traffic_only_enabled: true,
      allow_nested_items_to_be_public: false,
      public_network_access_enabled: true,
      tags: c.tags,
    },
    refs: { ...IN_RG, name: ["var.name_prefix"] },
  });
  const container = (key) => ({
    address: `azurerm_storage_container.${key}`,
    values: { name: "data", container_access_type: "private" },
    unknown: ["storage_account_id"],
    refs: { storage_account_id: ref(`azurerm_storage_account.${key}`, "id") },
  });
  const endpoint = (key, target, psc, extra = {}, extraUnknown = [], extraRefs = {}) => ({
    address: `azurerm_private_endpoint.${key}`,
    values: { name: `pe-${key}`, resource_group_name: c.rg, location: REGION, custom_network_interface_name: `nic-pe-${key}`, tags: c.tags, private_service_connection: [{ name: `psc-${key}`, is_manual_connection: false, ...psc }], ...extra },
    unknown: ["subnet_id", "private_service_connection.0.private_connection_resource_id", ...extraUnknown],
    refs: { ...IN_RG, subnet_id: ref("azurerm_subnet.pe", "id"), "private_service_connection.0.private_connection_resource_id": ref(target, "id"), ...extraRefs },
  });
  return {
    lab: c.id,
    variables: c.variables,
    data: [
      {
        address: SUBSCRIPTION,
        values: { id: `/subscriptions/${SUB}`, subscription_id: SUB, display_name: "Pay-As-You-Go", tenant_id: TENANT, state: "Enabled", location_placement_id: "Public_2014-09-01", quota_id: "PayAsYouGo_2014-09-01", spending_limit: "Off", tags: {} },
      },
    ],
    resources: [
      rgResource(c),

      // Provider.
      vnet("provider", "10.71.192.0/20"),
      subnet("svc", "provider", "10.71.192.0/24", { default_outbound_access_enabled: false }),
      subnet("pls", "provider", "10.71.193.0/24", { private_link_service_network_policies_enabled: false, default_outbound_access_enabled: false }),
      ...linuxVm(c, { name: "vm-svc", key: "svc", subnet: "azurerm_subnet.svc", customData: "I2Nsb3VkLWNvbmZpZwo= (cloud-init.yaml.tftpl)" }),
      {
        address: "azurerm_lb.svc",
        values: { name: "lb-svc", resource_group_name: c.rg, location: REGION, sku: "Standard", tags: c.tags, frontend_ip_configuration: [{ name: "fe-svc", private_ip_address_allocation: "Static", private_ip_address: "10.71.192.10" }] },
        unknown: ["frontend_ip_configuration.0.subnet_id"],
        refs: { ...IN_RG, "frontend_ip_configuration.0.subnet_id": ref("azurerm_subnet.svc", "id"), "frontend_ip_configuration.0.private_ip_address": ["local.lb_ip"] },
      },
      onLb("azurerm_lb_backend_address_pool.svc", { name: "pool-svc" }),
      onLb("azurerm_lb_probe.svc", { name: "probe-http", protocol: "Http", port: 80, request_path: "/" }),
      onLb("azurerm_lb_rule.svc", { name: "rule-http-80", protocol: "Tcp", frontend_port: 80, backend_port: 80, frontend_ip_configuration_name: "fe-svc" }, ["backend_address_pool_ids", "probe_id"], {
        backend_address_pool_ids: ref("azurerm_lb_backend_address_pool.svc", "id"),
        probe_id: ref("azurerm_lb_probe.svc", "id"),
      }),
      {
        address: "azurerm_network_interface_backend_address_pool_association.svc",
        values: { ip_configuration_name: "ipconfig1" },
        unknown: ["network_interface_id", "backend_address_pool_id"],
        refs: { network_interface_id: ref("azurerm_network_interface.svc", "id"), backend_address_pool_id: ref("azurerm_lb_backend_address_pool.svc", "id") },
      },
      {
        address: "azurerm_private_link_service.svc",
        values: { name: "pls-svc", resource_group_name: c.rg, location: REGION, auto_approval_subscription_ids: [SUB], visibility_subscription_ids: [SUB], tags: c.tags, nat_ip_configuration: [{ name: "nat-pls", primary: true }] },
        unknown: ["load_balancer_frontend_ip_configuration_ids", "nat_ip_configuration.0.subnet_id"],
        refs: {
          ...IN_RG,
          load_balancer_frontend_ip_configuration_ids: ["azurerm_lb.svc.frontend_ip_configuration[0].id", "azurerm_lb.svc.frontend_ip_configuration[0]", "azurerm_lb.svc.frontend_ip_configuration", "azurerm_lb.svc"],
          auto_approval_subscription_ids: ref(SUBSCRIPTION, "subscription_id"),
          visibility_subscription_ids: ref(SUBSCRIPTION, "subscription_id"),
          "nat_ip_configuration.0.subnet_id": ref("azurerm_subnet.pls", "id"),
        },
      },

      // Storage.
      account("st"),
      account("other"),
      container("st"),
      container("other"),

      // Consumer.
      vnet("consumer", "10.71.208.0/20"),
      subnet("pe", "consumer", "10.71.208.0/24", { default_outbound_access_enabled: false }),
      {
        address: "azurerm_subnet_service_endpoint_storage_policy.client",
        values: {
          name: "sep-storage",
          resource_group_name: c.rg,
          location: REGION,
          tags: c.tags,
          definition: [{ name: "allow-lab-st", description: "The client subnet may reach this lab's first storage account and no other.", service: "Microsoft.Storage" }],
        },
        unknown: ["definition.0.service_resources"],
        refs: { ...IN_RG, "definition.0.service_resources": ref("azurerm_storage_account.st", "id") },
      },
      subnet(
        "client",
        "consumer",
        "10.71.209.0/24",
        { service_endpoints: ["Microsoft.Storage"], default_outbound_access_enabled: true },
        { unknown: ["service_endpoint_policy_ids"], refs: { service_endpoint_policy_ids: ref("azurerm_subnet_service_endpoint_storage_policy.client", "id") } },
      ),
      endpoint("svc", "azurerm_private_link_service.svc", {}),
      { address: "azurerm_private_dns_zone.blob", values: { name: "privatelink.blob.core.windows.net", resource_group_name: c.rg, tags: c.tags }, refs: { ...inRg, tags: ["var.tags"] } },
      {
        address: "azurerm_private_dns_zone_virtual_network_link.consumer",
        values: { name: "link-vnet-consumer", resource_group_name: c.rg, private_dns_zone_name: "privatelink.blob.core.windows.net", registration_enabled: false, tags: c.tags },
        unknown: ["virtual_network_id"],
        refs: { ...inRg, private_dns_zone_name: ref("azurerm_private_dns_zone.blob", "name"), virtual_network_id: ref("azurerm_virtual_network.consumer", "id"), tags: ["var.tags"] },
      },
      endpoint("blob", "azurerm_storage_account.st", { subresource_names: ["blob"] }, { private_dns_zone_group: [{ name: "blob" }] }, ["private_dns_zone_group.0.private_dns_zone_ids"], {
        "private_dns_zone_group.0.private_dns_zone_ids": ref("azurerm_private_dns_zone.blob", "id"),
      }),
      ...linuxVm(c, { name: "vm-client", key: "client", subnet: "azurerm_subnet.client" }),
    ],
  };
};
