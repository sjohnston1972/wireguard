// az305-25-storage-design.mjs
//
// Plain English: lab 25's first-deploy plan, written out from
// labs/az305-25-storage-design/terraform/main.tf with a real session's values
// (slot 1, prefix l25k3x9q), as `terraform show -json` prints it (realistic.mjs
// adds what azurerm 4.81.0 computes). The accounts' names are known at plan;
// the containers' account ids, the lifecycle policy's account and the
// retention policy's container are not. The policy is unlocked (locked =
// false), which the scope check's immutability rule lets through.

import { ctx, IN_RG, ref, REGION, rgResource } from "../common.mjs";

export default () => {
  const c = ctx("az305-25-storage-design", "25");
  const account = (key, suffix, extra) => ({
    address: `azurerm_storage_account.${key}`,
    values: {
      name: `${c.prefix}${suffix}`,
      resource_group_name: c.rg,
      location: REGION,
      account_kind: "StorageV2",
      account_tier: "Standard",
      access_tier: "Hot",
      sftp_enabled: false,
      min_tls_version: "TLS1_2",
      https_traffic_only_enabled: true,
      allow_nested_items_to_be_public: false,
      shared_access_key_enabled: true,
      public_network_access_enabled: true,
      tags: c.tags,
      ...extra,
    },
    refs: { ...IN_RG, name: ["var.name_prefix"] },
    // The keys and connection strings: computed, and sensitive in azurerm's schema.
    sensitive: ["primary", "secondary"].flatMap((s) => [`${s}_access_key`, `${s}_connection_string`, `${s}_blob_connection_string`]),
  });
  const container = (key, accountKey) => ({
    address: `azurerm_storage_container.${key}`,
    values: { name: key, container_access_type: "private" },
    unknown: ["storage_account_id"],
    refs: { storage_account_id: ref(`azurerm_storage_account.${accountKey}`, "id") },
  });
  const rule = (name, prefix, baseBlob) => ({ name, enabled: true, filters: [{ blob_types: ["blockBlob"], prefix_match: [prefix] }], actions: [{ base_blob: [baseBlob] }] });
  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      // The data lake: hierarchical namespace, two file systems, a lifecycle policy.
      account("lake", "lake", { account_replication_type: "LRS", is_hns_enabled: true }),
      container("raw", "lake"),
      container("curated", "lake"),
      {
        address: "azurerm_storage_management_policy.lake",
        values: {
          rule: [
            rule("raw-cool-cold-archive", "raw/", {
              tier_to_cool_after_days_since_modification_greater_than: 30,
              tier_to_cold_after_days_since_modification_greater_than: 90,
              tier_to_archive_after_days_since_modification_greater_than: 180,
            }),
            rule("curated-delete-after-a-year", "curated/", { delete_after_days_since_modification_greater_than: 365 }),
          ],
        },
        unknown: ["storage_account_id"],
        refs: { storage_account_id: ref("azurerm_storage_account.lake", "id") },
      },
      // The records account: RA-GRS, and an unlocked 1-day retention policy on evidence.
      account("records", "rec", { account_replication_type: "RAGRS" }),
      container("evidence", "records"),
      {
        address: "azurerm_storage_container_immutability_policy.evidence",
        values: { immutability_period_in_days: 1, protected_append_writes_enabled: true, locked: false },
        unknown: ["storage_container_resource_manager_id"],
        refs: { storage_container_resource_manager_id: ref("azurerm_storage_container.evidence", "id") },
      },
    ],
  };
};
