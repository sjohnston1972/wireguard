// az700-39-vwan-secured-hub.mjs
//
// Plain English: lab 39's first-deploy plan, written out from
// labs/az700-39-vwan-secured-hub/terraform/main.tf with a real session's
// values at slot 31 (10.71.192.0/18): vnet-spoke1 10.71.192.0/20
// (snet-workload 10.71.192.0/24), vnet-spoke2 10.71.208.0/20 (snet-workload
// 10.71.208.0/24) and the hub's prefix 10.71.240.0/23 (the first /23 of the
// fourth /20), known at plan as test 6 needs.
//
// The hub firewall has no public IP resource (Azure gives it one) and no
// subnet; its virtual_hub block names the hub by id, unknown at plan. The
// routing intent's next hops are the firewall's id.

import { ctx, IN_RG, linuxVm, ref, REGION, rgResource } from "../common.mjs";

const SPOKE1 = "10.71.192.0/20";
const SPOKE2 = "10.71.208.0/20";
const SPOKES = [SPOKE1, SPOKE2];
const SPOKE_REFS = ["local.spoke1_cidr", "local.spoke2_cidr"];

export default () => {
  const c = ctx("az700-39-vwan-secured-hub", "39", { slot: 31 });
  const inRg = { resource_group_name: IN_RG.resource_group_name };
  const vnet = (key, cidr) => ({
    address: `azurerm_virtual_network.${key}`,
    values: { name: `vnet-${key}`, resource_group_name: c.rg, location: REGION, address_space: [cidr], tags: c.tags },
    refs: { ...IN_RG, address_space: [`local.${key}_cidr`] },
  });
  const subnet = (key, cidr) => ({
    address: `azurerm_subnet.${key}`,
    values: { name: "snet-workload", resource_group_name: c.rg, virtual_network_name: `vnet-${key}`, address_prefixes: [cidr], default_outbound_access_enabled: false },
    refs: { ...inRg, virtual_network_name: ref(`azurerm_virtual_network.${key}`, "name"), address_prefixes: [`local.${key}_subnet`] },
  });
  const connection = (key) => ({
    address: `azurerm_virtual_hub_connection.${key}`,
    values: { name: `conn-${key}`, internet_security_enabled: true },
    unknown: ["virtual_hub_id", "remote_virtual_network_id"],
    refs: { virtual_hub_id: ref("azurerm_virtual_hub.lab", "id"), remote_virtual_network_id: ref(`azurerm_virtual_network.${key}`, "id") },
  });
  const web = "I2Nsb3VkLWNvbmZpZwo= (cloud-init.yaml.tftpl, port 80)";
  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),

      // The WAN and its hub.
      { address: "azurerm_virtual_wan.lab", values: { name: "vwan-lab", resource_group_name: c.rg, location: REGION, type: "Standard", tags: c.tags }, refs: IN_RG },
      {
        address: "azurerm_virtual_hub.lab",
        values: { name: "vhub-lab", resource_group_name: c.rg, location: REGION, address_prefix: "10.71.240.0/23", sku: "Standard", tags: c.tags },
        unknown: ["virtual_wan_id"],
        refs: { ...IN_RG, virtual_wan_id: ref("azurerm_virtual_wan.lab", "id"), address_prefix: ["local.hub_prefix"] },
      },

      // The hub's firewall policy, its rules, and the firewall.
      { address: "azurerm_firewall_policy.hub", values: { name: "fwp-vhub", resource_group_name: c.rg, location: REGION, sku: "Basic", tags: c.tags }, refs: IN_RG },
      {
        address: "azurerm_firewall_policy_rule_collection_group.hub",
        values: {
          name: "rcg-vhub",
          priority: 100,
          network_rule_collection: [
            {
              name: "allow-spoke-to-spoke",
              priority: 100,
              action: "Allow",
              rule: [
                { name: "ssh", protocols: ["TCP"], source_addresses: SPOKES, destination_addresses: SPOKES, destination_ports: ["22"] },
                { name: "ping", protocols: ["ICMP"], source_addresses: SPOKES, destination_addresses: SPOKES, destination_ports: ["*"] },
              ],
            },
          ],
          application_rule_collection: [
            {
              name: "allow-web",
              priority: 200,
              action: "Allow",
              rule: [
                {
                  name: "ubuntu-mirrors",
                  source_addresses: SPOKES,
                  destination_fqdns: ["*.ubuntu.com"],
                  protocols: [
                    { type: "Http", port: 80 },
                    { type: "Https", port: 443 },
                  ],
                },
              ],
            },
          ],
        },
        unknown: ["firewall_policy_id"],
        refs: {
          firewall_policy_id: ref("azurerm_firewall_policy.hub", "id"),
          "network_rule_collection.0.rule.0.source_addresses": SPOKE_REFS,
          "network_rule_collection.0.rule.0.destination_addresses": SPOKE_REFS,
          "network_rule_collection.0.rule.1.source_addresses": SPOKE_REFS,
          "network_rule_collection.0.rule.1.destination_addresses": SPOKE_REFS,
          "application_rule_collection.0.rule.0.source_addresses": SPOKE_REFS,
        },
      },
      {
        address: "azurerm_firewall.hub",
        values: { name: "afw-vhub", resource_group_name: c.rg, location: REGION, sku_name: "AZFW_Hub", sku_tier: "Basic", tags: c.tags, virtual_hub: [{ public_ip_count: 1 }] },
        unknown: ["firewall_policy_id", "virtual_hub.0.virtual_hub_id"],
        refs: { ...IN_RG, firewall_policy_id: ref("azurerm_firewall_policy.hub", "id"), "virtual_hub.0.virtual_hub_id": ref("azurerm_virtual_hub.lab", "id") },
      },

      // The spokes and their hub connections.
      vnet("spoke1", SPOKE1),
      vnet("spoke2", SPOKE2),
      subnet("spoke1", "10.71.192.0/24"),
      subnet("spoke2", "10.71.208.0/24"),
      connection("spoke1"),
      connection("spoke2"),

      // Routing intent: private and internet traffic through the firewall.
      {
        address: "azurerm_virtual_hub_routing_intent.hub",
        values: {
          name: "ri-vhub",
          routing_policy: [
            { name: "InternetTrafficPolicy", destinations: ["Internet"] },
            { name: "PrivateTrafficPolicy", destinations: ["PrivateTraffic"] },
          ],
        },
        unknown: ["virtual_hub_id", "routing_policy.0.next_hop", "routing_policy.1.next_hop"],
        refs: { virtual_hub_id: ref("azurerm_virtual_hub.lab", "id"), "routing_policy.0.next_hop": ref("azurerm_firewall.hub", "id"), "routing_policy.1.next_hop": ref("azurerm_firewall.hub", "id") },
      },

      // A VM in each spoke.
      ...linuxVm(c, { name: "vm-spoke1", key: "spoke1", subnet: "azurerm_subnet.spoke1", customData: web }),
      ...linuxVm(c, { name: "vm-spoke2", key: "spoke2", subnet: "azurerm_subnet.spoke2", customData: web }),
    ],
  };
};
