# main.tf
#
# Plain English: monitoring at scale, the way a platform team does it. One
# central Log Analytics workspace (pay-as-you-go, capped at 0.05 GB a day,
# deleted for good on destroy) and a policy that makes every Key Vault in the
# group send its logs there, instead of someone remembering to. The custom
# definition is deployIfNotExists: if a vault has no diagnostic setting
# sending allLogs to the workspace, policy deploys one. Its assignment at
# rg-lab-<id> has a system-assigned identity holding Monitoring Contributor at
# rg-lab-<id> (the one role the definition lists), so the deployment is
# allowed. The vault is made after both, so policy's create-time evaluation
# remediates it about 15 minutes after deploy, with no remediation task. The
# built-in "Resource logs in Key Vault should be enabled" audits the result.
#
# Scope (spec §8.3, §17 ruling 28): the definition lives at the subscription
# (governance labs may define there) and is assigned only at rg-lab-<id>; it
# lists only Monitoring Contributor, a built-in on the allow-list, and deploys
# into the vault's own group. The workspace reaches the rule as an assignment
# parameter, so the rule itself is known at plan and the scope check can read
# it. The diagnostic setting policy writes goes with the vault. Ruling 30: no
# purge protection, 7 days' retention, purged on destroy (versions.tf).

data "azurerm_client_config" "current" {}

locals {
  # Built-in "Resource logs in Key Vault should be enabled" (AuditIfNotExists).
  kv_logs_audit_id = "/providers/Microsoft.Authorization/policyDefinitions/cf820ca0-f99e-4f3e-84fb-66e913812d21"
}

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

# ── The central workspace ────────────────────────────────────────────────

resource "azurerm_log_analytics_workspace" "lab" {
  name                = "log-central"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  daily_quota_gb      = 0.05
  tags                = var.tags
}

# ── The policy: Key Vault diagnostics, deployed if missing ───────────────

resource "azurerm_policy_definition" "kv_diagnostics" {
  name         = "lab-${var.lab_id}-kv-diagnostics"
  policy_type  = "Custom"
  mode         = "Indexed"
  display_name = "lab-${var.lab_id}: Key Vault logs to a central workspace"
  description  = "Lab policy: deploys a diagnostic setting sending a Key Vault's allLogs to the given workspace. Removed at tear-down."

  metadata = jsonencode({ category = "Monitoring" })

  parameters = jsonencode({
    logAnalytics = {
      type     = "String"
      metadata = { displayName = "Log Analytics workspace", description = "The workspace every Key Vault sends its logs to (its resource id)." }
    }
  })

  policy_rule = jsonencode({
    if = {
      field  = "type"
      equals = "Microsoft.KeyVault/vaults"
    }
    then = {
      effect = "deployIfNotExists"
      details = {
        type = "Microsoft.Insights/diagnosticSettings"
        # The only role the assignment's identity gets: Monitoring Contributor.
        roleDefinitionIds = [
          "/providers/Microsoft.Authorization/roleDefinitions/749f88d5-cbae-40b8-bcfc-e573ddc772fa",
        ]
        existenceCondition = {
          allOf = [
            {
              count = {
                field = "Microsoft.Insights/diagnosticSettings/logs[*]"
                where = {
                  allOf = [
                    { field = "Microsoft.Insights/diagnosticSettings/logs[*].enabled", equals = "true" },
                    { field = "Microsoft.Insights/diagnosticSettings/logs[*].categoryGroup", equals = "allLogs" },
                  ]
                }
              }
              greaterOrEquals = 1
            },
            { field = "Microsoft.Insights/diagnosticSettings/workspaceId", equals = "[parameters('logAnalytics')]" },
          ]
        }
        deployment = {
          properties = {
            mode = "incremental"
            template = {
              "$schema"      = "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#"
              contentVersion = "1.0.0.0"
              parameters = {
                vaultName    = { type = "string" }
                logAnalytics = { type = "string" }
              }
              resources = [
                {
                  type       = "Microsoft.KeyVault/vaults/providers/diagnosticSettings"
                  apiVersion = "2021-05-01-preview"
                  name       = "[concat(parameters('vaultName'), '/Microsoft.Insights/setbypolicy-alllogs')]"
                  properties = {
                    workspaceId = "[parameters('logAnalytics')]"
                    logs        = [{ categoryGroup = "allLogs", enabled = true }]
                    metrics     = [{ category = "AllMetrics", enabled = false }]
                  }
                },
              ]
            }
            parameters = {
              vaultName    = { value = "[field('name')]" }
              logAnalytics = { value = "[parameters('logAnalytics')]" }
            }
          }
        }
      }
    }
  })
}

resource "azurerm_resource_group_policy_assignment" "kv_diagnostics" {
  name                 = "lab-${var.lab_id}-kv-diagnostics"
  display_name         = "lab-${var.lab_id}: Key Vault logs to log-central"
  resource_group_id    = azurerm_resource_group.lab.id
  policy_definition_id = azurerm_policy_definition.kv_diagnostics.id
  location             = var.region

  parameters = jsonencode({
    logAnalytics = { value = azurerm_log_analytics_workspace.lab.id }
  })

  identity {
    type = "SystemAssigned"
  }

  non_compliance_message {
    content = "Lab policy: every Key Vault sends its logs to log-central."
  }
}

# The remediation identity's one role, at the lab's group only. It is brand
# new, so the Entra check is skipped (replication lag).
resource "azurerm_role_assignment" "remediation" {
  scope                            = azurerm_resource_group.lab.id
  role_definition_name             = "Monitoring Contributor"
  principal_id                     = azurerm_resource_group_policy_assignment.kv_diagnostics.identity[0].principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_resource_group_policy_assignment" "kv_logs_audit" {
  name                 = "lab-${var.lab_id}-kv-logs-audit"
  display_name         = "lab-${var.lab_id}: resource logs in Key Vault should be enabled"
  resource_group_id    = azurerm_resource_group.lab.id
  policy_definition_id = local.kv_logs_audit_id
}

# ── The governed resource: a Key Vault ───────────────────────────────────

resource "azurerm_key_vault" "lab" {
  name                          = "${var.name_prefix}kv"
  resource_group_name           = azurerm_resource_group.lab.name
  location                      = azurerm_resource_group.lab.location
  tenant_id                     = data.azurerm_client_config.current.tenant_id
  sku_name                      = "standard"
  rbac_authorization_enabled    = true
  public_network_access_enabled = true
  soft_delete_retention_days    = 7
  purge_protection_enabled      = false
  tags                          = var.tags

  # Made after the assignment and its role, so policy evaluates the new vault
  # and its deployment is allowed when it runs.
  depends_on = [
    azurerm_resource_group_policy_assignment.kv_diagnostics,
    azurerm_role_assignment.remediation,
  ]
}
