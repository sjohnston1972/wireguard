// scripts/test/fixtures/labs/plans/labs/az700-40-lb-advanced.mjs
//
// Plain English: lab 40's first-deploy plan, written out from
// labs/az700-40-lb-advanced/terraform/main.tf with a real session's values at
// slot 31 (10.71.192.0/18): vnet-uks 10.71.192.0/20 (snet-web 10.71.192.0/24,
// snet-nva 10.71.193.0/24 with the Gateway load balancer's frontend at
// 10.71.193.10) in rg-lab-<id>, uksouth, and vnet-ukw 10.71.208.0/20
// (snet-web 10.71.208.0/24) in rg-lab-<id>-secondary, ukwest. Every id is
// unknown at plan; the chain and the global pool's members reach into
// another load balancer's frontend_ip_configuration[0], which Terraform lists
// as every step of the traversal, longest first.

import { ctx, IN_RG, linuxVm, ref, REGION, rgResource, rgSecondaryResource, SECONDARY } from "../common.mjs";

/** A resource inside rg-lab-<id>-secondary: its group's name and location, and var.tags. */
const IN_RG2 = { resource_group_name: ref("azurerm_resource_group.secondary", "name"), location: ref("azurerm_resource_group.secondary", "location"), tags: ["var.tags"] };
/** azurerm_lb.<key>.frontend_ip_configuration[0].id, as Terraform lists its references. */
const frontendOf = (key, i = 0) => [`azurerm_lb.${key}.frontend_ip_configuration[${i}].id`, `azurerm_lb.${key}.frontend_ip_configuration[${i}]`, `azurerm_lb.${key}.frontend_ip_configuration`, `azurerm_lb.${key}`];

export default () => {
  const c = ctx("az700-40-lb-advanced", "40", { slot: 31 });
  const inRg = { resource_group_name: IN_RG.resource_group_name };
  const inRg2 = { resource_group_name: IN_RG2.resource_group_name };
  const vnet = (key, name, cidr, secondary) => ({
    address: `azurerm_virtual_network.${key}`,
    values: { name, resource_group_name: secondary ? c.rgSecondary : c.rg, location: secondary ? SECONDARY : REGION, address_space: [cidr], tags: c.tags },
    refs: { ...(secondary ? IN_RG2 : IN_RG), address_space: [`local.${key}_cidr`] },
  });
  const subnet = (key, name, vnetKey, cidr, secondary) => ({
    address: `azurerm_subnet.${key}`,
    values: { name, resource_group_name: secondary ? c.rgSecondary : c.rg, virtual_network_name: `vnet-${vnetKey}`, address_prefixes: [cidr], default_outbound_access_enabled: false },
    refs: { ...(secondary ? inRg2 : inRg), virtual_network_name: ref(`azurerm_virtual_network.${vnetKey}`, "name"), address_prefixes: [`local.${key}_cidr`] },
  });
  const nsg = (key, name, secondary) => ({
    address: `azurerm_network_security_group.${key}`,
    values: { name, resource_group_name: secondary ? c.rgSecondary : c.rg, location: secondary ? SECONDARY : REGION, tags: c.tags },
    refs: secondary ? IN_RG2 : IN_RG,
  });
  const rule = (key, nsgKey, nsgName, secondary, v) => ({
    address: `azurerm_network_security_rule.${key}`,
    values: { resource_group_name: secondary ? c.rgSecondary : c.rg, network_security_group_name: nsgName, priority: 100, direction: "Inbound", access: "Allow", source_port_range: "*", destination_address_prefix: "*", ...v },
    refs: { ...(secondary ? inRg2 : inRg), network_security_group_name: ref(`azurerm_network_security_group.${nsgKey}`, "name") },
  });
  const nsgOn = (key, subnetKey) => ({
    address: `azurerm_subnet_network_security_group_association.${key}`,
    values: {},
    unknown: ["subnet_id", "network_security_group_id"],
    refs: { subnet_id: ref(`azurerm_subnet.${subnetKey}`, "id"), network_security_group_id: ref(`azurerm_network_security_group.${key}`, "id") },
  });
  // The VMs: custom_data is known at plan (a template of known values), built from the region variable or local.gw_ip.
  const vm = (opts, customRefs, secondary = false, nicExtra = {}) => {
    const [nic, machine] = linuxVm(c, { ...opts, customData: `I2Nsb3VkLWNvbmZpZwo= (${opts.name})` });
    nic.values = { ...nic.values, ...nicExtra };
    machine.refs.custom_data = ["path.module", ...customRefs];
    if (secondary) {
      for (const r of [nic, machine]) {
        r.values = { ...r.values, resource_group_name: c.rgSecondary, location: SECONDARY };
        r.refs = { ...r.refs, ...IN_RG2 };
      }
    }
    return [nic, machine];
  };
  const pip = (key, name, secondary, extra = {}) => ({
    address: `azurerm_public_ip.${key}`,
    values: { name, resource_group_name: secondary ? c.rgSecondary : c.rg, location: secondary ? SECONDARY : REGION, allocation_method: "Static", sku: "Standard", tags: c.tags, ...extra },
    refs: secondary ? IN_RG2 : IN_RG,
  });
  const onLb = (address, lbKey, values, more = [], moreRefs = {}) => ({ address, values, unknown: ["loadbalancer_id", ...more], refs: { loadbalancer_id: ref(`azurerm_lb.${lbKey}`, "id"), ...moreRefs } });
  const pool = (key, name, extra = {}) => onLb(`azurerm_lb_backend_address_pool.${key}`, key, { name, ...extra });
  const lbRule = (key, fe, values = {}, withProbe = true) =>
    onLb(`azurerm_lb_rule.${key}`, key, { name: values.name ?? "rule-http-80", protocol: "Tcp", frontend_port: 80, backend_port: 80, frontend_ip_configuration_name: fe, ...values }, ["backend_address_pool_ids", ...(withProbe ? ["probe_id"] : [])], {
      backend_address_pool_ids: ref(`azurerm_lb_backend_address_pool.${key}`, "id"),
      ...(withProbe ? { probe_id: ref(`azurerm_lb_probe.${key}`, "id") } : {}),
    });
  const httpProbe = (key) => onLb(`azurerm_lb_probe.${key}`, key, { name: "probe-http", protocol: "Http", port: 80, request_path: "/" });
  const outbound = (key, fe) =>
    onLb(`azurerm_lb_outbound_rule.${key}`, key, { name: "outbound-web", protocol: "All", allocated_outbound_ports: 1024, idle_timeout_in_minutes: 4, tcp_reset_enabled: true, frontend_ip_configuration: [{ name: fe }] }, ["backend_address_pool_id"], {
      backend_address_pool_id: ref(`azurerm_lb_backend_address_pool.${key}`, "id"),
    });
  const member = (key, nicKey, poolKey) => ({
    address: `azurerm_network_interface_backend_address_pool_association.${key}`,
    values: { ip_configuration_name: "ipconfig1" },
    unknown: ["network_interface_id", "backend_address_pool_id"],
    refs: { network_interface_id: ref(`azurerm_network_interface.${nicKey}`, "id"), backend_address_pool_id: ref(`azurerm_lb_backend_address_pool.${poolKey}`, "id") },
  });
  const regionalMember = (key) => ({
    address: `azurerm_lb_backend_address_pool_address.${key}`,
    values: { name: `lb-${key}` },
    unknown: ["backend_address_pool_id", "backend_address_ip_configuration_id"],
    refs: { backend_address_pool_id: ref("azurerm_lb_backend_address_pool.global", "id"), backend_address_ip_configuration_id: frontendOf(key) },
  });
  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      rgSecondaryResource(c),

      // Networks.
      vnet("uks", "vnet-uks", "10.71.192.0/20", false),
      subnet("web", "snet-web", "uks", "10.71.192.0/24", false),
      subnet("nva", "snet-nva", "uks", "10.71.193.0/24", false),
      vnet("ukw", "vnet-ukw", "10.71.208.0/20", true),
      subnet("ukw_web", "snet-web", "ukw", "10.71.208.0/24", true),

      // NSGs.
      nsg("web", "nsg-web-uks", false),
      rule("web_http", "web", "nsg-web-uks", false, { name: "allow-http-from-internet", protocol: "Tcp", destination_port_ranges: ["80", "8080"], source_address_prefix: "Internet" }),
      nsgOn("web", "web"),
      nsg("nva", "nsg-nva", false),
      rule("nva_vxlan", "nva", "nsg-nva", false, { name: "allow-vxlan-from-vnet", protocol: "Udp", destination_port_range: "10800-10801", source_address_prefix: "VirtualNetwork" }),
      nsgOn("nva", "nva"),
      nsg("ukw_web", "nsg-web-ukw", true),
      rule("ukw_web_http", "ukw_web", "nsg-web-ukw", true, { name: "allow-http-from-internet", protocol: "Tcp", destination_port_ranges: ["80", "8080"], source_address_prefix: "Internet" }),
      nsgOn("ukw_web", "ukw_web"),

      // VMs.
      ...vm({ name: "vm-web1", key: "web1", subnet: "azurerm_subnet.web" }, ["var.region"]),
      ...vm({ name: "vm-nva", key: "nva", subnet: "azurerm_subnet.nva" }, ["local.gw_ip"], false, { ip_forwarding_enabled: true }),
      ...vm({ name: "vm-web2", key: "web2", subnet: "azurerm_subnet.ukw_web" }, ["var.secondary_region"], true),

      // lb-gw, the Gateway load balancer.
      {
        address: "azurerm_lb.gw",
        values: { name: "lb-gw", resource_group_name: c.rg, location: REGION, sku: "Gateway", tags: c.tags, frontend_ip_configuration: [{ name: "fe-gw", private_ip_address_allocation: "Static", private_ip_address: "10.71.193.10" }] },
        unknown: ["frontend_ip_configuration.0.subnet_id"],
        refs: { ...IN_RG, "frontend_ip_configuration.0.subnet_id": ref("azurerm_subnet.nva", "id"), "frontend_ip_configuration.0.private_ip_address": ["local.gw_ip"] },
      },
      pool("gw", "pool-nva", {
        tunnel_interface: [
          { identifier: 800, type: "Internal", protocol: "VXLAN", port: 10800 },
          { identifier: 801, type: "External", protocol: "VXLAN", port: 10801 },
        ],
      }),
      onLb("azurerm_lb_probe.gw", "gw", { name: "probe-ssh", protocol: "Tcp", port: 22 }),
      lbRule("gw", "fe-gw", { name: "rule-ha-ports", protocol: "All", frontend_port: 0, backend_port: 0 }),
      member("nva", "nva", "gw"),

      // lb-uks: fe-uks (lb-global's member, not chained) and fe-uks-chained (chained to lb-gw).
      pip("uks", "pip-lb-uks", false),
      pip("uks_chained", "pip-lb-uks-chained", false),
      {
        address: "azurerm_lb.uks",
        values: { name: "lb-uks", resource_group_name: c.rg, location: REGION, sku: "Standard", tags: c.tags, frontend_ip_configuration: [{ name: "fe-uks" }, { name: "fe-uks-chained" }] },
        unknown: ["frontend_ip_configuration.0.public_ip_address_id", "frontend_ip_configuration.1.public_ip_address_id", "frontend_ip_configuration.1.gateway_load_balancer_frontend_ip_configuration_id"],
        refs: {
          ...IN_RG,
          "frontend_ip_configuration.0.public_ip_address_id": ref("azurerm_public_ip.uks", "id"),
          "frontend_ip_configuration.1.public_ip_address_id": ref("azurerm_public_ip.uks_chained", "id"),
          "frontend_ip_configuration.1.gateway_load_balancer_frontend_ip_configuration_id": frontendOf("gw"),
        },
      },
      pool("uks", "pool-web"),
      httpProbe("uks"),
      lbRule("uks", "fe-uks", { disable_outbound_snat: true }),
      {
        address: "azurerm_lb_nat_rule.uks",
        values: { name: "nat-web-8081-8090", resource_group_name: c.rg, protocol: "Tcp", frontend_port_start: 8081, frontend_port_end: 8090, backend_port: 8080, frontend_ip_configuration_name: "fe-uks-chained" },
        unknown: ["loadbalancer_id", "backend_address_pool_id"],
        refs: { ...inRg, loadbalancer_id: ref("azurerm_lb.uks", "id"), backend_address_pool_id: ref("azurerm_lb_backend_address_pool.uks", "id") },
      },
      outbound("uks", "fe-uks"),
      member("web1", "web1", "uks"),

      // lb-ukw, in ukwest.
      pip("ukw", "pip-lb-ukw", true),
      {
        address: "azurerm_lb.ukw",
        values: { name: "lb-ukw", resource_group_name: c.rgSecondary, location: SECONDARY, sku: "Standard", tags: c.tags, frontend_ip_configuration: [{ name: "fe-ukw" }] },
        unknown: ["frontend_ip_configuration.0.public_ip_address_id"],
        refs: { ...IN_RG2, "frontend_ip_configuration.0.public_ip_address_id": ref("azurerm_public_ip.ukw", "id") },
      },
      pool("ukw", "pool-web"),
      httpProbe("ukw"),
      lbRule("ukw", "fe-ukw", { disable_outbound_snat: true }),
      outbound("ukw", "fe-ukw"),
      member("web2", "web2", "ukw"),

      // lb-global, homed in uksouth, over the two regional frontends.
      pip("global", "pip-lb-global", false, { sku_tier: "Global" }),
      {
        address: "azurerm_lb.global",
        values: { name: "lb-global", resource_group_name: c.rg, location: REGION, sku: "Standard", sku_tier: "Global", tags: c.tags, frontend_ip_configuration: [{ name: "fe-global" }] },
        unknown: ["frontend_ip_configuration.0.public_ip_address_id"],
        refs: { ...IN_RG, "frontend_ip_configuration.0.public_ip_address_id": ref("azurerm_public_ip.global", "id") },
      },
      pool("global", "pool-regions"),
      regionalMember("uks"),
      regionalMember("ukw"),
      lbRule("global", "fe-global", {}, false),
    ],
  };
};
