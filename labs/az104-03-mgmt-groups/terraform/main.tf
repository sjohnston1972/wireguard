# main.tf
#
# Plain English: a small management group tree of the lab's own,
# lab-<id>-root with lab-<id>-prod and lab-<id>-dev under it, and an audit
# policy defined and assigned at lab-<id>-root so you can watch it flow down
# to the children.
#
# Scope (spec §8.3): the tree hangs under the tenant root group and holds no
# subscriptions. The lab never moves the subscription: a policy or role on a
# parent would then reach the gateway too. The audit policy only reports, it
# never denies. Destroy removes the assignment, the definition, the children
# and then lab-<id>-root; the safety net deletes lab-<id>- management groups
# children first if anything is left.
#
# Rights (V): creating a management group needs the hierarchy setting
# "Require write permissions for creating new management groups" off (or
# Management Group Contributor at the tenant root). The creator is given
# Owner on the group it makes, which is what lets the pipeline define and
# assign policy there.

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

resource "azurerm_management_group" "prod" {
  name                       = "lab-${var.lab_id}-prod"
  display_name               = "lab-${var.lab_id}-prod"
  parent_management_group_id = azurerm_management_group.root.id
}

resource "azurerm_management_group" "dev" {
  name                       = "lab-${var.lab_id}-dev"
  display_name               = "lab-${var.lab_id}-dev"
  parent_management_group_id = azurerm_management_group.root.id
}

# ── An audit policy at lab-<id>-root ─────────────────────────────────────

resource "azurerm_policy_definition" "audit_environment_tag" {
  name                = "lab-${var.lab_id}-audit-environment-tag"
  policy_type         = "Custom"
  mode                = "Indexed"
  display_name        = "lab-${var.lab_id}: audit resources without an environment tag"
  description         = "Lab policy: reports resources with no environment tag. Audit only. Removed at tear-down."
  management_group_id = azurerm_management_group.root.id

  metadata = jsonencode({ category = "Tags" })

  policy_rule = jsonencode({
    if = {
      field  = "tags['environment']"
      exists = "false"
    }
    then = {
      effect = "audit"
    }
  })
}

# Assignment names at management group scope are at most 24 characters, too
# short for the lab-<id>- prefix; the display name carries it instead, and the
# assignment goes with lab-<id>-root.
resource "azurerm_management_group_policy_assignment" "audit_environment_tag" {
  name                 = "audit-environment-tag"
  display_name         = "lab-${var.lab_id}-audit-environment-tag"
  management_group_id  = azurerm_management_group.root.id
  policy_definition_id = azurerm_policy_definition.audit_environment_tag.id

  non_compliance_message {
    content = "Lab policy: tag resources with environment (for example prod or dev)."
  }
}
