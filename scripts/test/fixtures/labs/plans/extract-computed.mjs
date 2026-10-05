// scripts/test/fixtures/labs/plans/extract-computed.mjs
//
// Plain English: makes computed.json, the part of the azurerm and azuread
// provider schemas the realistic plan fixtures need: for every resource type
// the labs (and the scope fixtures) use, which attributes the provider
// computes. Terraform cannot plan a lab offline (it needs Azure), so the
// fixtures are written by hand, and this keeps their "known after apply"
// parts (after_unknown) true to the real providers: an attribute the
// provider computes and the configuration leaves unset is unknown at plan,
// exactly as `terraform show -json` prints it (azuread_group.mail_nickname,
// azurerm_management_group.subscription_ids, ...).
//
// Regenerate after a provider upgrade (no cloud calls; terraform init only
// downloads the providers):
//
//   mkdir /tmp/s && cd /tmp/s && printf '%s\n' 'terraform {' ' required_providers {' \
//     '  azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }' \
//     '  azuread = { source = "hashicorp/azuread", version = "~> 3.0" }' ' }' '}' > versions.tf
//   terraform init -backend=false && terraform providers schema -json > schema.json
//   node scripts/test/fixtures/labs/plans/extract-computed.mjs /tmp/s/schema.json

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TYPES = [
  // the labs
  "azuread_group", "azuread_user", "azurerm_consumption_budget_resource_group", "azurerm_linux_virtual_machine",
  "azurerm_management_group", "azurerm_management_group_policy_assignment", "azurerm_management_lock", "azurerm_monitor_action_group",
  "azurerm_network_interface", "azurerm_network_security_group", "azurerm_policy_definition", "azurerm_private_dns_zone",
  "azurerm_private_dns_zone_virtual_network_link", "azurerm_private_endpoint", "azurerm_resource_group",
  "azurerm_resource_group_policy_assignment", "azurerm_role_assignment", "azurerm_role_definition", "azurerm_storage_account",
  "azurerm_storage_blob", "azurerm_storage_container", "azurerm_storage_management_policy", "azurerm_storage_share",
  "azurerm_subnet", "azurerm_virtual_network",
  // data sources
  "data.azurerm_subscription",
];

/** { attrs: [computed attribute names], blocks: { name: tree } } for one schema block. */
function tree(block) {
  const attrs = Object.entries(block.attributes ?? {}).filter(([, a]) => a.computed).map(([k]) => k).sort();
  const blocks = {};
  for (const [k, b] of Object.entries(block.block_types ?? {})) {
    const t = tree(b.block);
    if (t.attrs.length || Object.keys(t.blocks).length) blocks[k] = t;
  }
  return { attrs, blocks };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const schema = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const out = { providers: {}, types: {} };
  for (const [name, p] of Object.entries(schema.provider_schemas)) {
    out.providers[name] = true;
    for (const t of TYPES) {
      const data = t.startsWith("data.");
      const s = (data ? p.data_source_schemas : p.resource_schemas)?.[data ? t.slice(5) : t];
      if (s) out.types[t] = tree(s.block);
    }
  }
  const missing = TYPES.filter((t) => !out.types[t]);
  if (missing.length) throw new Error(`not in the schema: ${missing.join(", ")}`);
  writeFileSync(new URL("./computed.json", import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
  console.log(`computed.json: ${Object.keys(out.types).length} types from ${Object.keys(out.providers).join(", ")}`);
}
