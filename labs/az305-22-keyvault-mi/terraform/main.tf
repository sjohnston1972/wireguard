# main.tf
#
# Plain English: secrets without passwords. A Key Vault using Azure RBAC
# holds two secrets, app-db-password and reports-api-key, made from random
# passwords. A small Ubuntu VM has two managed identities: its own
# system-assigned one, which may read every secret in the vault (Key Vault
# Secrets User at the vault), and a user-assigned one, id-<prefix>-app, which
# may read only reports-api-key (Key Vault Secrets User at that one secret).
# On the VM, either identity gets a token from the instance metadata service
# and reads from the vault over its public endpoint, through Azure's default
# outbound access (no public IP, no NAT gateway).
#
# The pipeline writes the secrets itself, so it is given Key Vault Secrets
# Officer at the vault, and the secrets wait two minutes for that data-plane
# role to reach the vault (RBAC propagation). Destroy runs the other way:
# the secrets go before the wait and the Officer assignment.
#
# Scope (spec §8.3, §17 rulings 30 and 37): every role assignment is inside
# the vault, with a built-in role on the allow-list. No purge protection,
# 7 days' retention, and the vault is purged on destroy (versions.tf).

data "azurerm_client_config" "current" {}

locals {
  # The first /20 of the slot; the VM subnet is its first /24.
  vnet_cidr = cidrsubnet(var.address_space, 2, 0)
  vms_cidr  = cidrsubnet(local.vnet_cidr, 4, 0)
}

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

# ── Network ───────────────────────────────────────────────────────────────

resource "azurerm_virtual_network" "lab" {
  name                = "vnet-lab"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.vnet_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "vms" {
  name                 = "snet-vms"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.lab.name
  address_prefixes     = [local.vms_cidr]
  # Ruling 37: the VM has no public IP and reaches the vault's public
  # endpoint through Azure's default outbound access, said explicitly.
  default_outbound_access_enabled = true
}

# ── The identities and the VM ─────────────────────────────────────────────

resource "azurerm_user_assigned_identity" "app" {
  name                = "id-${var.name_prefix}-app"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags
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
  name                            = "vm-app"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  size                            = "Standard_B1s"
  admin_username                  = "azureuser"
  admin_password                  = var.admin_password
  disable_password_authentication = false
  network_interface_ids           = [azurerm_network_interface.vm.id]
  tags                            = var.tags

  dynamic "admin_ssh_key" {
    for_each = var.ssh_public_key == "" ? [] : [var.ssh_public_key]
    content {
      username   = "azureuser"
      public_key = admin_ssh_key.value
    }
  }

  # Both kinds at once: the VM's own identity and the shared, user-assigned one.
  identity {
    type         = "SystemAssigned, UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }

  # Managed boot diagnostics: the portal's serial console works with no
  # storage account of our own.
  boot_diagnostics {}
}

# ── The vault ─────────────────────────────────────────────────────────────

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
}

# The pipeline's own principal writes the secrets (and deletes them at
# tear-down), so it needs a data-plane role on the vault.
resource "azurerm_role_assignment" "pipeline_officer" {
  scope                = azurerm_key_vault.lab.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
  principal_type       = "ServicePrincipal"
}

# RBAC takes a moment to reach the vault's data plane; without the wait the
# first secret write can be refused (403).
resource "time_sleep" "officer_propagation" {
  create_duration = "120s"

  depends_on = [azurerm_role_assignment.pipeline_officer]
}

resource "random_password" "app_db" {
  length  = 24
  special = false
}

resource "random_password" "reports_api" {
  length  = 32
  special = false
}

resource "azurerm_key_vault_secret" "app_db_password" {
  name         = "app-db-password"
  value        = random_password.app_db.result
  key_vault_id = azurerm_key_vault.lab.id
  content_type = "text/plain"
  tags         = var.tags

  depends_on = [time_sleep.officer_propagation]
}

resource "azurerm_key_vault_secret" "reports_api_key" {
  name         = "reports-api-key"
  value        = random_password.reports_api.result
  key_vault_id = azurerm_key_vault.lab.id
  content_type = "text/plain"
  tags         = var.tags

  depends_on = [time_sleep.officer_propagation]
}

# ── Who may read what ─────────────────────────────────────────────────────

# The VM's own identity: every secret in the vault.
resource "azurerm_role_assignment" "vm_secrets_user" {
  scope                            = azurerm_key_vault.lab.id
  role_definition_name             = "Key Vault Secrets User"
  principal_id                     = azurerm_linux_virtual_machine.vm.identity[0].principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

# The user-assigned identity: one secret only.
resource "azurerm_role_assignment" "app_reports_key" {
  scope                            = azurerm_key_vault_secret.reports_api_key.resource_versionless_id
  role_definition_name             = "Key Vault Secrets User"
  principal_id                     = azurerm_user_assigned_identity.app.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}
