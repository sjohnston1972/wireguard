# main.tf
#
# Plain English: the smallest lab there is: its own resource group and
# nothing else. Every lab creates rg-lab-<id> itself and builds everything
# else inside it (spec §3.4); the scope check refuses anything outside.

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}
