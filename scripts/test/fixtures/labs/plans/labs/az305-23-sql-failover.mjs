// az305-23-sql-failover.mjs
//
// Plain English: lab 23's first-deploy plan, written out from
// labs/az305-23-sql-failover/terraform/main.tf with a real session's values
// (slot 1, uksouth and ukwest, prefix l23k3x9q), as `terraform show -json`
// prints it (realistic.mjs adds what azurerm 4.81.0 computes). Names are
// known at plan; every id is not: the databases' server_id, the geo-secondary's
// source, the failover group's databases and partner server (an unknown id
// in a nested block, which the scope check holds to the lab's own resources),
// and the endpoints' targets. A list holding one unknown id is unknown as a
// whole ("databases", "private_dns_zone_ids"), as the release test's real
// plan printed it (2026-10-06): azurerm plans such a list wholly unknown, not
// a known list with one unknown element.

import { ctx, IN_RG, ref, REGION, rgResource, rgSecondaryResource, SECONDARY } from "../common.mjs";

/** A resource inside rg-lab-<id>-secondary: its group's name and location, and the tags. */
const IN_RG2 = { resource_group_name: ref("azurerm_resource_group.secondary", "name"), location: ref("azurerm_resource_group.secondary", "location"), tags: ["var.tags"] };

export default () => {
  const c = ctx("az305-23-sql-failover", "23");
  const inRg = { resource_group_name: IN_RG.resource_group_name };
  const zone = "privatelink.database.windows.net";
  const primary = "azurerm_mssql_server.primary";
  const secondary = "azurerm_mssql_server.secondary";

  const server = (key, rg, location, refs) => ({
    address: `azurerm_mssql_server.${key}`,
    values: {
      name: `${c.prefix}-sql${key[0]}`,
      resource_group_name: rg,
      location,
      version: "12.0",
      administrator_login: "labadmin",
      administrator_login_password: "(the session's admin password)",
      minimum_tls_version: "1.2",
      public_network_access_enabled: true,
      tags: c.tags,
    },
    refs: { ...refs, name: ["var.name_prefix"], administrator_login_password: ["var.admin_password"] },
    sensitive: ["administrator_login_password"],
  });

  const endpoint = (key) => {
    const target = `azurerm_mssql_server.${key}`;
    const name = `${c.prefix}-sql${key[0]}`;
    return {
      address: `azurerm_private_endpoint.${key}`,
      values: {
        name: `pe-${name}`,
        resource_group_name: c.rg,
        location: REGION,
        custom_network_interface_name: `nic-pe-${name}`,
        tags: c.tags,
        private_service_connection: [{ name: `psc-sql${key[0]}`, private_connection_resource_id: "(unknown)", subresource_names: ["sqlServer"], is_manual_connection: false }],
        private_dns_zone_group: [{ name: "sql" }],
      },
      unknown: ["subnet_id", "private_service_connection.0.private_connection_resource_id", "private_dns_zone_group.0.private_dns_zone_ids"],
      refs: {
        ...IN_RG,
        name: ref(target, "name"),
        custom_network_interface_name: ref(target, "name"),
        subnet_id: ref("azurerm_subnet.endpoints", "id"),
        "private_service_connection.0.private_connection_resource_id": ref(target, "id"),
        "private_dns_zone_group.0.private_dns_zone_ids": ref("azurerm_private_dns_zone.sql", "id"),
      },
    };
  };

  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      rgSecondaryResource(c),
      // Servers: one per region.
      server("primary", c.rg, REGION, IN_RG),
      server("secondary", c.rgSecondary, SECONDARY, IN_RG2),
      // appdb: a Basic primary and its explicit Basic geo-secondary.
      {
        address: "azurerm_mssql_database.primary",
        values: { name: "appdb", sku_name: "Basic", tags: c.tags },
        unknown: ["server_id"],
        refs: { server_id: ref(primary, "id"), tags: ["var.tags"] },
      },
      {
        address: "azurerm_mssql_database.secondary",
        values: { name: "appdb", sku_name: "Basic", create_mode: "Secondary", tags: c.tags },
        unknown: ["server_id", "creation_source_database_id"],
        refs: { server_id: ref(secondary, "id"), creation_source_database_id: ref("azurerm_mssql_database.primary", "id"), tags: ["var.tags"] },
      },
      // The failover group over appdb, Manual, partnered with the ukwest server.
      {
        address: "azurerm_mssql_failover_group.fog",
        values: { name: `${c.prefix}-fog`, tags: c.tags, partner_server: [{ id: "(unknown)" }], read_write_endpoint_failover_policy: [{ mode: "Manual" }] },
        unknown: ["server_id", "databases", "partner_server.0.id"],
        refs: { name: ["var.name_prefix"], server_id: ref(primary, "id"), databases: ref("azurerm_mssql_database.primary", "id"), tags: ["var.tags"], "partner_server.0.id": ref(secondary, "id") },
      },
      // scratch: serverless, on the ukwest server only.
      {
        address: "azurerm_mssql_database.scratch",
        values: { name: "scratch", sku_name: "GP_S_Gen5_1", min_capacity: 0.5, auto_pause_delay_in_minutes: 15, max_size_gb: 1, tags: c.tags },
        unknown: ["server_id"],
        refs: { server_id: ref(secondary, "id"), tags: ["var.tags"] },
      },
      // Network: VNet, private endpoints, private DNS.
      { address: "azurerm_virtual_network.lab", values: { name: "vnet-lab", resource_group_name: c.rg, location: REGION, address_space: ["10.64.64.0/20"], tags: c.tags }, refs: { ...IN_RG, address_space: ["local.vnet_cidr"] } },
      {
        address: "azurerm_subnet.endpoints",
        values: { name: "snet-pe", resource_group_name: c.rg, virtual_network_name: "vnet-lab", address_prefixes: ["10.64.64.0/24"] },
        refs: { ...inRg, virtual_network_name: ref("azurerm_virtual_network.lab", "name"), address_prefixes: ["local.endpoints_cidr"] },
      },
      { address: "azurerm_private_dns_zone.sql", values: { name: zone, resource_group_name: c.rg, tags: c.tags }, refs: { ...inRg, tags: ["var.tags"] } },
      {
        address: "azurerm_private_dns_zone_virtual_network_link.lab",
        values: { name: "link-vnet-lab", resource_group_name: c.rg, private_dns_zone_name: zone, registration_enabled: false, tags: c.tags },
        unknown: ["virtual_network_id"],
        refs: { ...inRg, private_dns_zone_name: ref("azurerm_private_dns_zone.sql", "name"), virtual_network_id: ref("azurerm_virtual_network.lab", "id"), tags: ["var.tags"] },
      },
      endpoint("primary"),
      endpoint("secondary"),
    ],
  };
};
