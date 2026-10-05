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

resource "azurerm_virtual_network" "source" {
  name                = "vnet-source"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [cidrsubnet(var.address_space, 2, 0)]
  tags                = var.tags
}

resource "azurerm_subnet" "vms" {
  name                            = "snet-vms"
  resource_group_name             = azurerm_resource_group.lab.name
  virtual_network_name            = azurerm_virtual_network.source.name
  address_prefixes                = [cidrsubnet(cidrsubnet(var.address_space, 2, 0), 4, 0)]
  default_outbound_access_enabled = true
}

resource "azurerm_network_interface" "vm" {
  name                = "nic-vm-app"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.vms.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_linux_virtual_machine" "vm" {
  name                  = "vm-app"
  resource_group_name   = azurerm_resource_group.lab.name
  location              = azurerm_resource_group.lab.location
  size                  = "Standard_B1s"
  admin_username        = "azureuser"
  admin_password        = var.admin_password
  network_interface_ids = [azurerm_network_interface.vm.id]
  tags                  = var.tags

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts-gen2"
    version   = "latest"
  }
}

resource "azurerm_recovery_services_vault" "lab" {
  name                = "rsv-lab"
  resource_group_name = azurerm_resource_group.secondary.name
  location            = azurerm_resource_group.secondary.location
  sku                 = "Standard"
  tags                = var.tags
}

resource "azurerm_site_recovery_replicated_vm" "vm" {
  name                       = "vm-app"
  resource_group_name        = azurerm_resource_group.secondary.name
  recovery_vault_name        = azurerm_recovery_services_vault.lab.name
  source_vm_id               = azurerm_linux_virtual_machine.vm.id
  target_resource_group_id   = azurerm_resource_group.secondary.id
  source_recovery_fabric_name = "fabric-source"
}
