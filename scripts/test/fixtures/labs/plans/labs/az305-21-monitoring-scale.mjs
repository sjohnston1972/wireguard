// scripts/test/fixtures/labs/plans/labs/az305-21-monitoring-scale.mjs
//
// Plain English: lab 21's first-deploy plan, as `terraform show -json` prints
// it (realistic.mjs adds what azurerm 4.81.0 computes). A capped workspace, a
// deployIfNotExists definition whose rule is all constants (known at plan:
// the workspace id reaches it as an assignment parameter, which is unknown),
// its assignment with a system-assigned identity, Monitoring Contributor for
// that identity, the built-in audit's assignment, and a Key Vault whose
// tenant comes from the client config read at plan. jsonencode prints object
// keys sorted, so the JSON strings here are built the same way.

import { IN_RG, REGION, SUB, TENANT, ctx, ref, rgResource } from "../common.mjs";

/** JSON as Terraform's jsonencode prints it: object keys sorted, no spaces. */
const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
const jsonencode = (v) => JSON.stringify(sorted(v));

const PIPELINE_OBJECT_ID = "6a1f2e3d-4c5b-4a69-8f7e-0d1c2b3a4f5e";
const PIPELINE_CLIENT_ID = "0b9c8d7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e";

const DINE_RULE = {
  if: { field: "type", equals: "Microsoft.KeyVault/vaults" },
  then: {
    effect: "deployIfNotExists",
    details: {
      type: "Microsoft.Insights/diagnosticSettings",
      roleDefinitionIds: ["/providers/Microsoft.Authorization/roleDefinitions/749f88d5-cbae-40b8-bcfc-e573ddc772fa"],
      existenceCondition: {
        allOf: [
          {
            count: {
              field: "Microsoft.Insights/diagnosticSettings/logs[*]",
              where: {
                allOf: [
                  { field: "Microsoft.Insights/diagnosticSettings/logs[*].enabled", equals: "true" },
                  { field: "Microsoft.Insights/diagnosticSettings/logs[*].categoryGroup", equals: "allLogs" },
                ],
              },
            },
            greaterOrEquals: 1,
          },
          { field: "Microsoft.Insights/diagnosticSettings/workspaceId", equals: "[parameters('logAnalytics')]" },
        ],
      },
      deployment: {
        properties: {
          mode: "incremental",
          template: {
            $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
            contentVersion: "1.0.0.0",
            parameters: { vaultName: { type: "string" }, logAnalytics: { type: "string" } },
            resources: [
              {
                type: "Microsoft.KeyVault/vaults/providers/diagnosticSettings",
                apiVersion: "2021-05-01-preview",
                name: "[concat(parameters('vaultName'), '/Microsoft.Insights/setbypolicy-alllogs')]",
                properties: {
                  workspaceId: "[parameters('logAnalytics')]",
                  logs: [{ categoryGroup: "allLogs", enabled: true }],
                  metrics: [{ category: "AllMetrics", enabled: false }],
                },
              },
            ],
          },
          parameters: { vaultName: { value: "[field('name')]" }, logAnalytics: { value: "[parameters('logAnalytics')]" } },
        },
      },
    },
  },
};

export default () => {
  const c = ctx("az305-21-monitoring-scale", "21");
  const ws = "azurerm_log_analytics_workspace.lab";
  const dine = "azurerm_resource_group_policy_assignment.kv_diagnostics";
  return {
    lab: c.id,
    variables: c.variables,
    data: [
      {
        address: "data.azurerm_client_config.current",
        values: { id: `clientConfigs/clientId=${PIPELINE_CLIENT_ID};objectId=${PIPELINE_OBJECT_ID};subscriptionId=${SUB};tenantId=${TENANT}`, client_id: PIPELINE_CLIENT_ID, object_id: PIPELINE_OBJECT_ID, subscription_id: SUB, tenant_id: TENANT },
      },
    ],
    resources: [
      rgResource(c),
      {
        address: ws,
        values: { name: "log-central", resource_group_name: c.rg, location: REGION, sku: "PerGB2018", retention_in_days: 30, daily_quota_gb: 0.05, tags: c.tags },
        refs: IN_RG,
      },
      {
        address: "azurerm_policy_definition.kv_diagnostics",
        values: {
          name: `lab-${c.id}-kv-diagnostics`,
          policy_type: "Custom",
          mode: "Indexed",
          display_name: `lab-${c.id}: Key Vault logs to a central workspace`,
          description: "Lab policy: deploys a diagnostic setting sending a Key Vault's allLogs to the given workspace. Removed at tear-down.",
          metadata: jsonencode({ category: "Monitoring" }),
          parameters: jsonencode({ logAnalytics: { type: "String", metadata: { displayName: "Log Analytics workspace", description: "The workspace every Key Vault sends its logs to (its resource id)." } } }),
          policy_rule: jsonencode(DINE_RULE),
        },
        refs: { name: ["var.lab_id"], display_name: ["var.lab_id"] },
      },
      {
        address: dine,
        values: {
          name: `lab-${c.id}-kv-diagnostics`,
          display_name: `lab-${c.id}: Key Vault logs to log-central`,
          location: REGION,
          identity: [{ type: "SystemAssigned", identity_ids: null }],
          non_compliance_message: [{ content: "Lab policy: every Key Vault sends its logs to log-central.", policy_definition_reference_id: null }],
        },
        // The workspace id is known only after apply, so the parameters built from it are too.
        unknown: ["resource_group_id", "policy_definition_id", "parameters"],
        refs: {
          name: ["var.lab_id"],
          display_name: ["var.lab_id"],
          resource_group_id: ref("azurerm_resource_group.lab", "id"),
          policy_definition_id: ref("azurerm_policy_definition.kv_diagnostics", "id"),
          location: ["var.region"],
          parameters: ref(ws, "id"),
        },
      },
      {
        address: "azurerm_role_assignment.remediation",
        values: { role_definition_name: "Monitoring Contributor", principal_type: "ServicePrincipal", skip_service_principal_aad_check: true },
        unknown: ["scope", "principal_id"],
        refs: {
          scope: ref("azurerm_resource_group.lab", "id"),
          // Terraform lists every step of a traversal through a nested block, longest first.
          principal_id: [`${dine}.identity[0].principal_id`, `${dine}.identity[0]`, `${dine}.identity`, dine],
        },
      },
      {
        address: "azurerm_resource_group_policy_assignment.kv_logs_audit",
        values: {
          name: `lab-${c.id}-kv-logs-audit`,
          display_name: `lab-${c.id}: resource logs in Key Vault should be enabled`,
          policy_definition_id: "/providers/Microsoft.Authorization/policyDefinitions/cf820ca0-f99e-4f3e-84fb-66e913812d21",
        },
        unknown: ["resource_group_id"],
        refs: { name: ["var.lab_id"], display_name: ["var.lab_id"], resource_group_id: ref("azurerm_resource_group.lab", "id"), policy_definition_id: ["local.kv_logs_audit_id"] },
      },
      {
        address: "azurerm_key_vault.lab",
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
    ],
  };
};
