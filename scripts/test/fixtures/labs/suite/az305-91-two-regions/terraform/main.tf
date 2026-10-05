resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

resource "azurerm_resource_group" "secondary" {
  name     = "${var.resource_group_name}-secondary"
  location = var.secondary_region
  tags     = var.tags
}

resource "azurerm_storage_account" "primary" {
  name                     = "${var.name_prefix}uks"
  resource_group_name      = azurerm_resource_group.lab.name
  location                 = azurerm_resource_group.lab.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  tags                     = var.tags
}

resource "azurerm_storage_account" "secondary" {
  name                     = "${var.name_prefix}ukw"
  resource_group_name      = azurerm_resource_group.secondary.name
  location                 = azurerm_resource_group.secondary.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
  tags                     = var.tags
}

resource "azurerm_storage_container" "data" {
  name               = "data"
  storage_account_id = azurerm_storage_account.secondary.id
}
