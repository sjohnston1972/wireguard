data "azurerm_subscription" "current" {}

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

resource "azurerm_user_assigned_identity" "app" {
  name                = "id-${var.name_prefix}-app"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags
}

resource "azurerm_role_definition" "ops" {
  role_definition_id = "0d1c2b3a-4f5e-4a6b-8c7d-9e0f1a2b3c4d"
  name               = "lab-${var.lab_id}-ops"
  scope              = data.azurerm_subscription.current.id
  assignable_scopes  = [azurerm_resource_group.lab.id]

  permissions {
    actions = ["Microsoft.Compute/*/read"]
  }
}

resource "azurerm_role_assignment" "reader" {
  scope                = azurerm_resource_group.lab.id
  role_definition_name = "Reader"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_role_assignment" "ops" {
  scope              = azurerm_resource_group.lab.id
  role_definition_id = azurerm_role_definition.ops.role_definition_resource_id
  principal_id       = azurerm_user_assigned_identity.app.principal_id
  principal_type     = "ServicePrincipal"
}

resource "azurerm_role_assignment" "metrics" {
  scope                = azurerm_user_assigned_identity.app.id
  role_definition_name = "Monitoring Reader"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
  principal_type       = "ServicePrincipal"
}
