// az104-16-lb-appgw.mjs
//
// Plain English: lab 16's first-deploy plan, written out from
// labs/az104-16-lb-appgw/terraform/main.tf with a real session's values
// (slot 1: snet-web 10.64.64.0/24 with the load balancer's frontend at
// 10.64.64.10, snet-appgw 10.64.65.0/24 with the gateway's private frontend
// at 10.64.65.10). The two web VMs are count instances ([0] and [1]); the
// gateway's backend addresses are theirs, unknown until their NICs exist.

import { ctx, IN_RG, linuxVm, ref, REGION, rgResource } from "../common.mjs";

export default () => {
  const c = ctx("az104-16-lb-appgw", "16");
  const inRg = { resource_group_name: IN_RG.resource_group_name };
  const subnet = (key, cidr) => ({
    address: `azurerm_subnet.${key}`,
    values: { name: `snet-${key}`, resource_group_name: c.rg, virtual_network_name: "vnet-lab", address_prefixes: [cidr] },
    refs: { ...inRg, virtual_network_name: ref("azurerm_virtual_network.lab", "name"), address_prefixes: [`local.${key}_cidr`] },
  });
  const rule = (key, v) => ({
    address: `azurerm_network_security_rule.${key}`,
    values: { resource_group_name: c.rg, network_security_group_name: "nsg-appgw", direction: "Inbound", access: "Allow", protocol: "Tcp", source_port_range: "*", destination_address_prefix: "*", ...v },
    refs: { ...inRg, network_security_group_name: ref("azurerm_network_security_group.appgw", "name") },
  });
  const onLb = (address, values, more = [], moreRefs = {}) => ({ address, values, unknown: ["loadbalancer_id", ...more], refs: { loadbalancer_id: ref("azurerm_lb.web", "id"), ...moreRefs } });
  const vm = (i) => linuxVm(c, { name: `vm-web${i + 1}`, key: `web[${i}]`, subnet: "azurerm_subnet.web", customData: "I2Nsb3VkLWNvbmZpZwo= (cloud-init.yaml.tftpl, port 80)" });
  const member = (i) => ({
    address: `azurerm_network_interface_backend_address_pool_association.web[${i}]`,
    values: { ip_configuration_name: "ipconfig1" },
    unknown: ["network_interface_id", "backend_address_pool_id"],
    refs: { network_interface_id: ref(`azurerm_network_interface.web[${i}]`, "id"), backend_address_pool_id: ref("azurerm_lb_backend_address_pool.web", "id") },
  });
  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      { address: "azurerm_virtual_network.lab", values: { name: "vnet-lab", resource_group_name: c.rg, location: REGION, address_space: ["10.64.64.0/20"], tags: c.tags }, refs: { ...IN_RG, address_space: ["local.vnet_cidr"] } },
      subnet("web", "10.64.64.0/24"),
      subnet("appgw", "10.64.65.0/24"),

      // The web VMs and the internal Standard load balancer in front of them.
      ...vm(0),
      ...vm(1),
      {
        address: "azurerm_lb.web",
        values: { name: "lbi-web", resource_group_name: c.rg, location: REGION, sku: "Standard", tags: c.tags, frontend_ip_configuration: [{ name: "fe-web", private_ip_address_allocation: "Static", private_ip_address: "10.64.64.10" }] },
        unknown: ["frontend_ip_configuration.0.subnet_id"],
        refs: { ...IN_RG, "frontend_ip_configuration.0.subnet_id": ref("azurerm_subnet.web", "id"), "frontend_ip_configuration.0.private_ip_address": ["local.lb_ip"] },
      },
      onLb("azurerm_lb_backend_address_pool.web", { name: "pool-web" }),
      onLb("azurerm_lb_probe.http", { name: "probe-tcp-80", protocol: "Tcp", port: 80 }),
      onLb("azurerm_lb_rule.http", { name: "rule-http-80", protocol: "Tcp", frontend_port: 80, backend_port: 80, frontend_ip_configuration_name: "fe-web" }, ["backend_address_pool_ids", "probe_id"], {
        backend_address_pool_ids: ref("azurerm_lb_backend_address_pool.web", "id"),
        probe_id: ref("azurerm_lb_probe.http", "id"),
      }),
      member(0),
      member(1),

      // The Application Gateway's subnet NSG.
      { address: "azurerm_network_security_group.appgw", values: { name: "nsg-appgw", resource_group_name: c.rg, location: REGION, tags: c.tags }, refs: IN_RG },
      rule("appgw_manager", { name: "allow-gateway-manager", priority: 100, destination_port_range: "65200-65535", source_address_prefix: "GatewayManager" }),
      rule("appgw_http", { name: "allow-http-from-vnet", priority: 110, destination_port_range: "80", source_address_prefix: "VirtualNetwork" }),
      {
        address: "azurerm_subnet_network_security_group_association.appgw",
        values: {},
        unknown: ["subnet_id", "network_security_group_id"],
        refs: { subnet_id: ref("azurerm_subnet.appgw", "id"), network_security_group_id: ref("azurerm_network_security_group.appgw", "id") },
      },

      // The Application Gateway, Basic, and the public IP it must own.
      { address: "azurerm_public_ip.appgw", values: { name: "pip-appgw", resource_group_name: c.rg, location: REGION, allocation_method: "Static", sku: "Standard", tags: c.tags }, refs: IN_RG },
      {
        address: "azurerm_application_gateway.web",
        values: {
          name: "agw-web",
          resource_group_name: c.rg,
          location: REGION,
          tags: c.tags,
          sku: [{ name: "Basic", tier: "Basic", capacity: 1 }],
          gateway_ip_configuration: [{ name: "gateway-ip" }],
          frontend_port: [{ name: "port-80", port: 80 }],
          frontend_ip_configuration: [{ name: "fe-public" }, { name: "fe-private", private_ip_address_allocation: "Static", private_ip_address: "10.64.65.10" }],
          backend_address_pool: [{ name: "pool-web" }],
          backend_http_settings: [{ name: "http-80", port: 80, protocol: "Http", cookie_based_affinity: "Disabled", request_timeout: 30 }],
          http_listener: [{ name: "listener-private-80", frontend_ip_configuration_name: "fe-private", frontend_port_name: "port-80", protocol: "Http" }],
          request_routing_rule: [{ name: "rule-web", priority: 100, rule_type: "Basic", http_listener_name: "listener-private-80", backend_address_pool_name: "pool-web", backend_http_settings_name: "http-80" }],
          ssl_policy: [{ policy_type: "Predefined", policy_name: "AppGwSslPolicy20220101" }],
        },
        unknown: ["gateway_ip_configuration.0.subnet_id", "frontend_ip_configuration.0.public_ip_address_id", "frontend_ip_configuration.1.subnet_id", "backend_address_pool.0.ip_addresses"],
        refs: {
          ...IN_RG,
          "gateway_ip_configuration.0.subnet_id": ref("azurerm_subnet.appgw", "id"),
          "frontend_ip_configuration.0.public_ip_address_id": ref("azurerm_public_ip.appgw", "id"),
          "frontend_ip_configuration.1.subnet_id": ref("azurerm_subnet.appgw", "id"),
          "frontend_ip_configuration.1.private_ip_address": ["local.appgw_ip"],
          "backend_address_pool.0.ip_addresses": ["azurerm_network_interface.web"],
        },
      },
    ],
  };
};
