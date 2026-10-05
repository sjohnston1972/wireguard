// az305-24-cosmos.mjs
//
// Plain English: lab 24's first-deploy plan, written out from
// labs/az305-24-cosmos/terraform/main.tf with a real session's values (slot 1,
// prefix l24k3x9q), as `terraform show -json` prints it (realistic.mjs adds
// what azurerm 4.81.0 computes). Every name is known at plan, the account's
// region too (its group's location comes from var.region); only ids, keys,
// endpoints and the containers' throughput (none: serverless) are not.

import { ctx, IN_RG, ref, REGION, rgResource } from "../common.mjs";

export default () => {
  const c = ctx("az305-24-cosmos", "24");
  const account = "azurerm_cosmosdb_account.lab";
  const name = `${c.prefix}-cosmos`;
  const inRg = { resource_group_name: IN_RG.resource_group_name };
  const container = (key, values) => ({
    address: `azurerm_cosmosdb_sql_container.${key}`,
    values: { resource_group_name: c.rg, account_name: name, database_name: "shop", partition_key_version: 2, ...values },
    refs: { ...inRg, account_name: ref(account, "name"), database_name: ref("azurerm_cosmosdb_sql_database.shop", "name") },
  });
  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      {
        address: account,
        values: {
          name,
          resource_group_name: c.rg,
          location: REGION,
          offer_type: "Standard",
          kind: "GlobalDocumentDB",
          free_tier_enabled: false,
          public_network_access_enabled: true,
          local_authentication_enabled: true,
          tags: c.tags,
          capabilities: [{ name: "EnableServerless" }],
          consistency_policy: [{ consistency_level: "Session" }],
          geo_location: [{ location: REGION, failover_priority: 0 }],
        },
        refs: { ...IN_RG, name: ["var.name_prefix"], "geo_location.0.location": ref("azurerm_resource_group.lab", "location") },
        // The keys and connection strings: computed, and sensitive in azurerm's schema.
        sensitive: ["primary", "secondary"].flatMap((s) => [`${s}_key`, `${s}_readonly_key`, `${s}_sql_connection_string`, `${s}_readonly_sql_connection_string`, `${s}_mongodb_connection_string`, `${s}_readonly_mongodb_connection_string`]),
      },
      {
        address: "azurerm_cosmosdb_sql_database.shop",
        values: { name: "shop", resource_group_name: c.rg, account_name: name },
        refs: { ...inRg, account_name: ref(account, "name") },
      },
      container("orders", { name: "orders", partition_key_paths: ["/customerId"] }),
      container("events", { name: "events", partition_key_paths: ["/tenantId", "/userId"], partition_key_kind: "MultiHash" }),
      container("by_status", { name: "bykey-status", partition_key_paths: ["/status"] }),
    ],
  };
};
