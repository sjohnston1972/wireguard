# main.tf
#
# Plain English: two Entra users (ann and ben), a helpdesk group with ann in
# it, a custom "VM operator" role, and two role assignments at the lab's
# resource group: Reader for the group, the custom role for ben. A free
# network security group gives the group something to read and gives you a
# resource to practise resource-scope assignments on.
#
# Scope (spec §8.3, §8.4): every Entra name starts lab-<id>-. The custom role
# is a governance definition, created at the subscription (as the governance
# labs may) but assignable only at rg-lab-<id>; it keeps the fixed GUID from
# labs/setup/allowed-roles.json so the pipeline's ABAC condition allows it.
# Nothing is assigned at subscription scope. Destroy removes the assignments
# first, then the role, the group and the users; the safety net catches any
# lab-<id>- leftovers.

data "azurerm_subscription" "current" {}

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

# Something for Reader to see, and for a resource-scope assignment. Free.
resource "azurerm_network_security_group" "demo" {
  name                = "nsg-lab-demo"
  location            = azurerm_resource_group.lab.location
  resource_group_name = azurerm_resource_group.lab.name
  tags                = var.tags
}

# ── Entra users and group ────────────────────────────────────────────────

resource "azuread_user" "ann" {
  display_name          = "lab-${var.lab_id}-ann"
  user_principal_name   = "lab-${var.lab_id}-ann@${var.upn_domain}"
  mail_nickname         = "lab-${var.lab_id}-ann"
  password              = var.admin_password
  force_password_change = false
  department            = "Helpdesk"
  job_title             = "Helpdesk analyst"
  usage_location        = "GB"
}

resource "azuread_user" "ben" {
  display_name          = "lab-${var.lab_id}-ben"
  user_principal_name   = "lab-${var.lab_id}-ben@${var.upn_domain}"
  mail_nickname         = "lab-${var.lab_id}-ben"
  password              = var.admin_password
  force_password_change = false
  department            = "Operations"
  job_title             = "VM operator"
  usage_location        = "GB"
}

resource "azuread_group" "helpdesk" {
  display_name     = "lab-${var.lab_id}-helpdesk"
  mail_nickname    = "lab-${var.lab_id}-helpdesk"
  description      = "Lab group: Reader on rg-lab-${var.lab_id}. Removed at tear-down."
  security_enabled = true
  members          = [azuread_user.ann.object_id]
}

# ── Custom role ──────────────────────────────────────────────────────────

resource "azurerm_role_definition" "vm_operator" {
  role_definition_id = "7331dcae-09d3-477e-8da7-2895697f0fc0"
  name               = "lab-${var.lab_id}-vm-operator"
  scope              = data.azurerm_subscription.current.id
  description        = "Lab custom role: see, start, stop and restart VMs, nothing else. Removed at tear-down."

  permissions {
    actions = [
      "Microsoft.Resources/subscriptions/resourceGroups/read",
      "Microsoft.Compute/virtualMachines/read",
      "Microsoft.Compute/virtualMachines/start/action",
      "Microsoft.Compute/virtualMachines/powerOff/action",
      "Microsoft.Compute/virtualMachines/deallocate/action",
      "Microsoft.Compute/virtualMachines/restart/action",
    ]
    not_actions = []
  }

  assignable_scopes = [azurerm_resource_group.lab.id]
}

# ── Role assignments, both at the lab's resource group ───────────────────

resource "azurerm_role_assignment" "helpdesk_reader" {
  scope                = azurerm_resource_group.lab.id
  role_definition_name = "Reader"
  principal_id         = azuread_group.helpdesk.object_id
  principal_type       = "Group"
}

resource "azurerm_role_assignment" "ben_vm_operator" {
  scope              = azurerm_resource_group.lab.id
  role_definition_id = azurerm_role_definition.vm_operator.role_definition_resource_id
  principal_id       = azuread_user.ben.object_id
  principal_type     = "User"
}
