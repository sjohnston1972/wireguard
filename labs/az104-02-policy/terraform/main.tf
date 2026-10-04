# main.tf
#
# Plain English: two policy assignments on the lab's resource group, a tagged
# storage account with a delete lock, and one untagged resource that shows up
# as non-compliant.
#
# - Policy lab-<id>-require-costcentre-tag (a custom definition, kept at the
#   subscription as the governance labs may) denies new resources without a
#   costcentre tag. Its effect is a parameter, so you can switch it to Audit.
# - The built-in Allowed locations policy permits only the session's region.
# - nsg-untagged (free) is created before the deny lands, so it stays as an
#   existing, non-compliant resource for the compliance view.
# - The storage account carries the costcentre tag and a CanNotDelete lock.
#   Destroy removes the lock first (it depends on the account); the pipeline's
#   unblock step removes any lock left behind, including ones you add.
#
# Both assignments are on rg-lab-<id> and go with it; nothing is assigned at
# subscription scope (spec §8.3).

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

locals {
  # Built-in "Allowed locations" (Indexed; skips resource groups and "global").
  allowed_locations_id = "/providers/Microsoft.Authorization/policyDefinitions/e56962a6-4747-49cd-b67b-bf8b01975c4c"
}

# ── The non-compliant resource: made before the deny exists ─────────────

resource "azurerm_network_security_group" "untagged" {
  name                = "nsg-untagged"
  location            = azurerm_resource_group.lab.location
  resource_group_name = azurerm_resource_group.lab.name
  tags                = var.tags
}

# ── Policy: require a costcentre tag ─────────────────────────────────────

resource "azurerm_policy_definition" "require_costcentre_tag" {
  name         = "lab-${var.lab_id}-require-costcentre-tag"
  policy_type  = "Custom"
  mode         = "Indexed"
  display_name = "lab-${var.lab_id}: require a costcentre tag"
  description  = "Lab policy: resources need the tag named in tagName. Removed at tear-down."

  metadata = jsonencode({ category = "Tags" })

  parameters = jsonencode({
    tagName = {
      type         = "String"
      metadata     = { displayName = "Tag name", description = "The tag every new resource must carry." }
      defaultValue = "costcentre"
    }
    effect = {
      type          = "String"
      metadata      = { displayName = "Effect", description = "Deny refuses the change; Audit only reports it." }
      allowedValues = ["Deny", "Audit", "Disabled"]
      defaultValue  = "Deny"
    }
  })

  policy_rule = jsonencode({
    if = {
      field  = "[concat('tags[', parameters('tagName'), ']')]"
      exists = "false"
    }
    then = {
      effect = "[parameters('effect')]"
    }
  })
}

resource "azurerm_resource_group_policy_assignment" "require_tag" {
  name                 = "lab-${var.lab_id}-require-tag"
  display_name         = "lab-${var.lab_id}: require a costcentre tag"
  resource_group_id    = azurerm_resource_group.lab.id
  policy_definition_id = azurerm_policy_definition.require_costcentre_tag.id

  parameters = jsonencode({
    tagName = { value = "costcentre" }
    effect  = { value = "Deny" }
  })

  non_compliance_message {
    content = "Lab policy: every resource in this group needs a costcentre tag."
  }

  depends_on = [azurerm_network_security_group.untagged]
}

# ── Policy: built-in Allowed locations ───────────────────────────────────

resource "azurerm_resource_group_policy_assignment" "allowed_locations" {
  name                 = "lab-${var.lab_id}-allowed-locations"
  display_name         = "lab-${var.lab_id}: allowed locations"
  resource_group_id    = azurerm_resource_group.lab.id
  policy_definition_id = local.allowed_locations_id

  parameters = jsonencode({
    listOfAllowedLocations = { value = [var.region] }
  })

  non_compliance_message {
    content = "Lab policy: resources in this group may only be created in ${var.region}."
  }
}

# ── A tagged storage account with a delete lock ──────────────────────────

resource "azurerm_storage_account" "tagged" {
  name                            = "${var.name_prefix}tags"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  account_kind                    = "StorageV2"
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  access_tier                     = "Hot"
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false
  tags                            = merge(var.tags, { costcentre = "cc-1234" })
}

resource "azurerm_management_lock" "no_delete" {
  name       = "lab-${var.lab_id}-no-delete"
  scope      = azurerm_storage_account.tagged.id
  lock_level = "CanNotDelete"
  notes      = "Lab lock: try deleting the account. Tear-down removes it."
}
