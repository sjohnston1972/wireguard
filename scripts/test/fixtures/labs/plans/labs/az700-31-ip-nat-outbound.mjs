// az700-31-ip-nat-outbound.mjs
//
// Plain English: lab 31's first-deploy plan, written out from
// labs/az700-31-ip-nat-outbound/terraform/main.tf with a real session's
// values at slot 31 (vnet-hub 10.71.192.0/20, snet-nat 10.71.192.0/24,
// snet-lb 10.71.193.0/24). The prefixes, the NAT gateway and the load
// balancer are known at plan; every id that joins them (the prefix
// association, the subnet association, the frontend's prefix, the pool and
// the outbound rule) is known only after apply.

import { ctx, IN_RG, linuxVm, ref, REGION, rgResource } from "../common.mjs";

export default () => {
  const c = ctx("az700-31-ip-nat-outbound", "31", { slot: 31 });
  const inRg = { resource_group_name: IN_RG.resource_group_name };
  const subnet = (key, cidr) => ({
    address: `azurerm_subnet.${key}`,
    values: { name: `snet-${key}`, resource_group_name: c.rg, virtual_network_name: "vnet-hub", address_prefixes: [cidr], default_outbound_access_enabled: false },
    refs: { ...inRg, virtual_network_name: ref("azurerm_virtual_network.hub", "name"), address_prefixes: [`local.${key}_subnet`] },
  });
  const nsgAssoc = (key) => ({
    address: `azurerm_subnet_network_security_group_association.${key}`,
    values: {},
    unknown: ["subnet_id", "network_security_group_id"],
    refs: { subnet_id: ref(`azurerm_subnet.${key}`, "id"), network_security_group_id: ref("azurerm_network_security_group.hub", "id") },
  });
  const prefix = (key) => ({
    address: `azurerm_public_ip_prefix.${key}`,
    values: { name: `pfx-${key}`, resource_group_name: c.rg, location: REGION, sku: "Standard", prefix_length: 31, zones: ["1", "2", "3"], tags: c.tags },
    refs: IN_RG,
  });
  const [natNic, natVm] = linuxVm(c, { name: "vm-nat", subnet: "azurerm_subnet.nat" });
  const [lbNic, lbVm] = linuxVm(c, { name: "vm-lb", subnet: "azurerm_subnet.lb" });

  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      { address: "azurerm_virtual_network.hub", values: { name: "vnet-hub", resource_group_name: c.rg, location: REGION, address_space: ["10.71.192.0/20"], tags: c.tags }, refs: { ...IN_RG, address_space: ["local.hub_cidr"] } },
      subnet("nat", "10.71.192.0/24"),
      subnet("lb", "10.71.193.0/24"),
      { address: "azurerm_network_security_group.hub", values: { name: "nsg-hub", resource_group_name: c.rg, location: REGION, tags: c.tags }, refs: IN_RG },
      nsgAssoc("nat"),
      nsgAssoc("lb"),
      prefix("nat"),
      prefix("lb"),
      { address: "azurerm_nat_gateway.hub", values: { name: "ng-hub", resource_group_name: c.rg, location: REGION, sku_name: "Standard", idle_timeout_in_minutes: 4, tags: c.tags }, refs: IN_RG },
      {
        address: "azurerm_nat_gateway_public_ip_prefix_association.nat",
        values: {},
        unknown: ["nat_gateway_id", "public_ip_prefix_id"],
        refs: { nat_gateway_id: ref("azurerm_nat_gateway.hub", "id"), public_ip_prefix_id: ref("azurerm_public_ip_prefix.nat", "id") },
      },
      {
        address: "azurerm_subnet_nat_gateway_association.nat",
        values: {},
        unknown: ["subnet_id", "nat_gateway_id"],
        refs: { subnet_id: ref("azurerm_subnet.nat", "id"), nat_gateway_id: ref("azurerm_nat_gateway.hub", "id") },
      },
      {
        address: "azurerm_lb.out",
        values: { name: "lb-out", resource_group_name: c.rg, location: REGION, sku: "Standard", tags: c.tags, frontend_ip_configuration: [{ name: "fe-out" }] },
        unknown: ["frontend_ip_configuration.0.public_ip_prefix_id"],
        refs: { ...IN_RG, "frontend_ip_configuration.0.public_ip_prefix_id": ref("azurerm_public_ip_prefix.lb", "id") },
      },
      { address: "azurerm_lb_backend_address_pool.out", values: { name: "be-out" }, unknown: ["loadbalancer_id"], refs: { loadbalancer_id: ref("azurerm_lb.out", "id") } },
      {
        address: "azurerm_lb_outbound_rule.out",
        values: { name: "ob-all", protocol: "All", allocated_outbound_ports: 32000, idle_timeout_in_minutes: 4, tcp_reset_enabled: true, frontend_ip_configuration: [{ name: "fe-out" }] },
        unknown: ["loadbalancer_id", "backend_address_pool_id"],
        refs: { loadbalancer_id: ref("azurerm_lb.out", "id"), backend_address_pool_id: ref("azurerm_lb_backend_address_pool.out", "id") },
      },
      natNic,
      natVm,
      lbNic,
      {
        address: "azurerm_network_interface_backend_address_pool_association.lb",
        values: { ip_configuration_name: "ipconfig1" },
        unknown: ["network_interface_id", "backend_address_pool_id"],
        refs: { network_interface_id: ref("azurerm_network_interface.lb", "id"), backend_address_pool_id: ref("azurerm_lb_backend_address_pool.out", "id") },
      },
      lbVm,
    ],
  };
};
