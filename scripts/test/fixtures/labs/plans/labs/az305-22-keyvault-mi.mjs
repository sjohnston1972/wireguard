// scripts/test/fixtures/labs/plans/labs/az305-22-keyvault-mi.mjs
//
// Plain English: lab 22's first-deploy plan, as `terraform show -json` prints
// it (realistic.mjs adds what azurerm 4.81.0, random 3.9.1 and time 0.14.2
// compute). A VNet, a VM with a system-assigned and a user-assigned identity,
// an RBAC Key Vault whose tenant comes from the client config read at plan,
// the pipeline's Officer assignment (its principal known at plan, from the
// same data source), a two-minute wait, two random passwords stored as
// secrets (unknown and sensitive), and the two Secrets User assignments: the
// VM's identity at the vault and the user-assigned one at one secret.

import { IN_RG, REGION, SUB, TENANT, ctx, linuxVm, ref, rgResource } from "../common.mjs";

const PIPELINE_OBJECT_ID = "6a1f2e3d-4c5b-4a69-8f7e-0d1c2b3a4f5e";
const PIPELINE_CLIENT_ID = "0b9c8d7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e";

export default () => {
  const c = ctx("az305-22-keyvault-mi", "22");
  const kv = "azurerm_key_vault.lab";
  const uai = "azurerm_user_assigned_identity.app";
  const vmAddress = "azurerm_linux_virtual_machine.vm";
  const [nic, vm] = linuxVm(c, { name: "vm-app", key: "vm", subnet: "azurerm_subnet.vms" });
  // Both identity kinds: the user-assigned identity's id is known only after apply.
  vm.values.identity = [{ type: "SystemAssigned, UserAssigned", identity_ids: ["(unknown)"] }];
  vm.unknown.push("identity.0.identity_ids");
  vm.refs["identity.0.identity_ids"] = ref(uai, "id");
  const password = (key, length) => ({
    address: `random_password.${key}`,
    values: { length, special: false },
    sensitive: ["bcrypt_hash", "result"],
  });
  const secret = (key, name, from) => ({
    address: `azurerm_key_vault_secret.${key}`,
    values: { name, content_type: "text/plain", tags: c.tags },
    unknown: ["value", "key_vault_id"],
    refs: { value: ref(`random_password.${from}`, "result"), key_vault_id: ref(kv, "id"), tags: ["var.tags"] },
    sensitive: ["value"],
  });
  return {
    lab: c.id,
    providers: ["azurerm", "random", "time"],
    variables: c.variables,
    data: [
      {
        address: "data.azurerm_client_config.current",
        values: { id: `clientConfigs/clientId=${PIPELINE_CLIENT_ID};objectId=${PIPELINE_OBJECT_ID};subscriptionId=${SUB};tenantId=${TENANT}`, client_id: PIPELINE_CLIENT_ID, object_id: PIPELINE_OBJECT_ID, subscription_id: SUB, tenant_id: TENANT },
      },
    ],
    resources: [
      rgResource(c),
      { address: "azurerm_virtual_network.lab", values: { name: "vnet-lab", resource_group_name: c.rg, location: REGION, address_space: ["10.64.64.0/20"], tags: c.tags }, refs: { ...IN_RG, address_space: ["local.vnet_cidr"] } },
      {
        address: "azurerm_subnet.vms",
        values: { name: "snet-vms", resource_group_name: c.rg, virtual_network_name: "vnet-lab", address_prefixes: ["10.64.64.0/24"], default_outbound_access_enabled: true },
        refs: { resource_group_name: IN_RG.resource_group_name, virtual_network_name: ref("azurerm_virtual_network.lab", "name"), address_prefixes: ["local.vms_cidr"] },
      },
      { address: uai, values: { name: `id-${c.prefix}-app`, resource_group_name: c.rg, location: REGION, tags: c.tags }, refs: { ...IN_RG, name: ["var.name_prefix"] } },
      nic,
      vm,
      {
        address: kv,
        values: {
          name: `${c.prefix}kv`,
          resource_group_name: c.rg,
          location: REGION,
          tenant_id: TENANT,
          sku_name: "standard",
          rbac_authorization_enabled: true,
          public_network_access_enabled: true,
          soft_delete_retention_days: 7,
          purge_protection_enabled: false,
          tags: c.tags,
        },
        refs: { ...IN_RG, name: ["var.name_prefix"], tenant_id: ref("data.azurerm_client_config.current", "tenant_id") },
      },
      {
        address: "azurerm_role_assignment.pipeline_officer",
        values: { role_definition_name: "Key Vault Secrets Officer", principal_id: PIPELINE_OBJECT_ID, principal_type: "ServicePrincipal" },
        unknown: ["scope"],
        refs: { scope: ref(kv, "id"), principal_id: ref("data.azurerm_client_config.current", "object_id") },
      },
      { address: "time_sleep.officer_propagation", values: { create_duration: "120s" } },
      password("app_db", 24),
      password("reports_api", 32),
      secret("app_db_password", "app-db-password", "app_db"),
      secret("reports_api_key", "reports-api-key", "reports_api"),
      {
        address: "azurerm_role_assignment.vm_secrets_user",
        values: { role_definition_name: "Key Vault Secrets User", principal_type: "ServicePrincipal", skip_service_principal_aad_check: true },
        unknown: ["scope", "principal_id"],
        refs: {
          scope: ref(kv, "id"),
          // Terraform lists every step of a traversal through a nested block, longest first.
          principal_id: [`${vmAddress}.identity[0].principal_id`, `${vmAddress}.identity[0]`, `${vmAddress}.identity`, vmAddress],
        },
      },
      {
        address: "azurerm_role_assignment.app_reports_key",
        values: { role_definition_name: "Key Vault Secrets User", principal_type: "ServicePrincipal", skip_service_principal_aad_check: true },
        unknown: ["scope", "principal_id"],
        refs: { scope: ref("azurerm_key_vault_secret.reports_api_key", "resource_versionless_id"), principal_id: ref(uai, "principal_id") },
      },
    ],
  };
};
