# main.tf
#
# Plain English: a landing zone in miniature. A management group tree of the
# lab's own, shaped like the Cloud Adoption Framework's: lab-<id>-root with
# platform, landingzones (corp and online under it) and sandbox. A policy
# initiative (a policy set) stored at lab-<id>-root groups two built-in
# definitions and one custom audit, and is assigned at landingzones, so corp
# and online inherit it; sandbox gets a deny of public IP addresses instead.
# Two least-privilege custom roles, netops and appops, are defined at the
# subscription but assignable only at rg-lab-<id>, and each is assigned there
# to the user-assigned managed identity it was designed for (its "persona").
#
# Scope (spec §8.3, §17 rulings 27 and 29): the tree hangs under the tenant
# root group and holds no subscription; the lab never moves the subscription
# in, because a deny on a parent would then reach the gateway too. Nothing is
# assigned at subscription scope. The custom roles keep the fixed GUIDs from
# labs/setup/allowed-roles.json, so the pipeline's ABAC condition lets it
# assign them, and only inside rg-lab-<id> (identity change 2, approved by
# Steven 2026-10-05). Destroy removes the role assignments before the roles,
# the assignments before the initiative and definition, and the management
# groups children first; the safety net catches any lab-<id>- leftovers.

data "azurerm_subscription" "current" {}

locals {
  # Built-in "Not allowed resource types" (Deny by default).
  not_allowed_types_id = "/providers/Microsoft.Authorization/policyDefinitions/6c112d4e-5bc7-47ae-a041-ea2d9dccd749"
}

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

# ── The tree ─────────────────────────────────────────────────────────────

resource "azurerm_management_group" "root" {
  name         = "lab-${var.lab_id}-root"
  display_name = "lab-${var.lab_id}-root"
}

resource "azurerm_management_group" "platform" {
  name                       = "lab-${var.lab_id}-platform"
  display_name               = "lab-${var.lab_id}-platform"
  parent_management_group_id = azurerm_management_group.root.id
}

resource "azurerm_management_group" "landingzones" {
  name                       = "lab-${var.lab_id}-landingzones"
  display_name               = "lab-${var.lab_id}-landingzones"
  parent_management_group_id = azurerm_management_group.root.id
}

resource "azurerm_management_group" "corp" {
  name                       = "lab-${var.lab_id}-corp"
  display_name               = "lab-${var.lab_id}-corp"
  parent_management_group_id = azurerm_management_group.landingzones.id
}

resource "azurerm_management_group" "online" {
  name                       = "lab-${var.lab_id}-online"
  display_name               = "lab-${var.lab_id}-online"
  parent_management_group_id = azurerm_management_group.landingzones.id
}

resource "azurerm_management_group" "sandbox" {
  name                       = "lab-${var.lab_id}-sandbox"
  display_name               = "lab-${var.lab_id}-sandbox"
  parent_management_group_id = azurerm_management_group.root.id
}

# ── Policy: a custom audit and the baseline initiative, at lab-<id>-root ──

resource "azurerm_policy_definition" "audit_costcentre" {
  name                = "lab-${var.lab_id}-audit-costcentre"
  policy_type         = "Custom"
  mode                = "Indexed"
  display_name        = "lab-${var.lab_id}: audit resources without a costcentre tag"
  description         = "Lab policy: reports resources with no costcentre tag. Audit only. Removed at tear-down."
  management_group_id = azurerm_management_group.root.id

  metadata = jsonencode({ category = "Tags" })

  policy_rule = jsonencode({
    if = {
      field  = "tags['costcentre']"
      exists = "false"
    }
    then = {
      effect = "audit"
    }
  })
}

resource "azurerm_management_group_policy_set_definition" "baseline" {
  name                = "lab-${var.lab_id}-baseline"
  policy_type         = "Custom"
  display_name        = "lab-${var.lab_id}: landing zone baseline"
  description         = "Lab initiative: where resources may live and how they are tagged. Removed at tear-down."
  management_group_id = azurerm_management_group.root.id

  metadata = jsonencode({ category = "General" })

  policy_definition_group {
    name         = "location"
    display_name = "Location"
    description  = "Where resources may be created."
  }

  policy_definition_group {
    name         = "tagging"
    display_name = "Tagging"
    description  = "The cost centre tag every landing zone uses."
  }

  # Built-in "Allowed locations": the session's region only.
  policy_definition_reference {
    policy_definition_id = "/providers/Microsoft.Authorization/policyDefinitions/e56962a6-4747-49cd-b67b-bf8b01975c4c"
    reference_id         = "allowedLocations"
    policy_group_names   = ["location"]
    parameter_values     = jsonencode({ listOfAllowedLocations = { value = [var.region] } })
  }

  # Built-in "Require a tag on resource groups": costcentre.
  policy_definition_reference {
    policy_definition_id = "/providers/Microsoft.Authorization/policyDefinitions/96670d01-0a4d-4649-9c89-2d3abc0a5025"
    reference_id         = "requireCostcentreOnGroups"
    policy_group_names   = ["tagging"]
    parameter_values     = jsonencode({ tagName = { value = "costcentre" } })
  }

  # The lab's own audit of resources without the tag.
  policy_definition_reference {
    policy_definition_id = azurerm_policy_definition.audit_costcentre.id
    reference_id         = "auditCostcentre"
    policy_group_names   = ["tagging"]
  }
}

# Assignment names at management group scope are at most 24 characters, too
# short for the lab-<id>- prefix; the display name carries it instead.
resource "azurerm_management_group_policy_assignment" "baseline" {
  name                 = "lz-baseline"
  display_name         = "lab-${var.lab_id}-lz-baseline"
  management_group_id  = azurerm_management_group.landingzones.id
  policy_definition_id = azurerm_management_group_policy_set_definition.baseline.id

  non_compliance_message {
    content = "Lab policy: landing zones use the session's region and a costcentre tag."
  }
}

resource "azurerm_management_group_policy_assignment" "sandbox_no_pip" {
  name                 = "sandbox-no-pip"
  display_name         = "lab-${var.lab_id}-sandbox-no-pip"
  management_group_id  = azurerm_management_group.sandbox.id
  policy_definition_id = local.not_allowed_types_id

  parameters = jsonencode({
    listOfResourceTypesNotAllowed = { value = ["Microsoft.Network/publicIPAddresses"] }
  })

  non_compliance_message {
    content = "Lab policy: sandboxes get no public IP addresses."
  }
}

# ── Role design: two custom roles and the identities they are for ───────

# The network operations persona: read the network, change NSG rules and routes.
resource "azurerm_role_definition" "netops" {
  role_definition_id = "60bdbc03-b25a-4a83-9fce-b2c5afff563c"
  name               = "lab-${var.lab_id}-netops"
  scope              = data.azurerm_subscription.current.id
  description        = "Lab custom role: read the network and change NSG rules and routes, nothing else. Removed at tear-down."

  permissions {
    actions = [
      "Microsoft.Network/*/read",
      "Microsoft.Network/networkSecurityGroups/securityRules/write",
      "Microsoft.Network/networkSecurityGroups/securityRules/delete",
      "Microsoft.Network/routeTables/routes/write",
      "Microsoft.Network/routeTables/routes/delete",
      "Microsoft.Resources/subscriptions/resourceGroups/read",
    ]
    not_actions = []
  }

  assignable_scopes = [azurerm_resource_group.lab.id]
}

# The application operations persona: see VMs and their metrics, start, restart and deallocate them.
resource "azurerm_role_definition" "appops" {
  role_definition_id = "bd52e05a-22cb-4bd5-b56c-3396add9b7c0"
  name               = "lab-${var.lab_id}-appops"
  scope              = data.azurerm_subscription.current.id
  description        = "Lab custom role: see VMs and their metrics, start, restart and deallocate them, nothing else. Removed at tear-down."

  permissions {
    actions = [
      "Microsoft.Compute/*/read",
      "Microsoft.Compute/virtualMachines/start/action",
      "Microsoft.Compute/virtualMachines/restart/action",
      "Microsoft.Compute/virtualMachines/deallocate/action",
      "Microsoft.Insights/metrics/read",
      "Microsoft.Resources/subscriptions/resourceGroups/read",
    ]
    not_actions = []
  }

  assignable_scopes = [azurerm_resource_group.lab.id]
}

resource "azurerm_user_assigned_identity" "netops" {
  name                = "id-${var.name_prefix}-netops"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags
}

resource "azurerm_user_assigned_identity" "appops" {
  name                = "id-${var.name_prefix}-appops"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags
}

# Each role at rg-lab-<id>, the only scope it is assignable at. The identities
# are brand new, so the Entra check is skipped (replication lag).
resource "azurerm_role_assignment" "netops" {
  scope                            = azurerm_resource_group.lab.id
  role_definition_id               = azurerm_role_definition.netops.role_definition_resource_id
  principal_id                     = azurerm_user_assigned_identity.netops.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "appops" {
  scope                            = azurerm_resource_group.lab.id
  role_definition_id               = azurerm_role_definition.appops.role_definition_resource_id
  principal_id                     = azurerm_user_assigned_identity.appops.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}
