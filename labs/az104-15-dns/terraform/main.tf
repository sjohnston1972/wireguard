# main.tf
#
# Plain English: Azure DNS both ways.
#
#   Public:  a zone named <name_prefix>.example.com. example.com is reserved
#            for documentation (RFC 2606), so the zone can never shadow a
#            real domain, and it is never delegated: only Azure's own name
#            servers for it answer, when you ask them directly. Its A record
#            points at a documentation address (RFC 5737), and a CNAME
#            points at that.
#   Private: lab15.internal, linked to the lab VNet with auto-registration,
#            so vm-web gets an A record of its own, beside www, which is
#            made by hand. The pipeline also links the zone to the gateway
#            VNet while the lab is peered (dns_link in lab.yaml), never this
#            Terraform; the gateway's tunnel DNS forwards "internal" to Azure
#            DNS, so tunnel clients resolve these names too.
#
# vm-web serves its name on port 80 with python3's built-in web server.

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
}

# ── Public zone: <prefix>.example.com, never delegated ───────────────────

resource "azurerm_dns_zone" "public" {
  name                = "${var.name_prefix}.example.com"
  resource_group_name = azurerm_resource_group.lab.name
  tags                = var.tags
}

resource "azurerm_dns_a_record" "www" {
  name                = "www"
  zone_name           = azurerm_dns_zone.public.name
  resource_group_name = azurerm_resource_group.lab.name
  ttl                 = 300
  # TEST-NET-3, an address reserved for documentation: it reaches nothing.
  records = ["203.0.113.10"]
  tags    = var.tags
}

resource "azurerm_dns_cname_record" "app" {
  name                = "app"
  zone_name           = azurerm_dns_zone.public.name
  resource_group_name = azurerm_resource_group.lab.name
  ttl                 = 300
  record              = "www.${azurerm_dns_zone.public.name}"
  tags                = var.tags
}

# ── Private zone: lab15.internal, auto-registration from the lab VNet ────

resource "azurerm_private_dns_zone" "internal" {
  name                = "lab15.internal"
  resource_group_name = azurerm_resource_group.lab.name
  tags                = var.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "lab" {
  name                  = "link-vnet-lab"
  resource_group_name   = azurerm_resource_group.lab.name
  private_dns_zone_name = azurerm_private_dns_zone.internal.name
  virtual_network_id    = azurerm_virtual_network.lab.id
  registration_enabled  = true
  tags                  = var.tags
}

resource "azurerm_private_dns_a_record" "www" {
  name                = "www"
  zone_name           = azurerm_private_dns_zone.internal.name
  resource_group_name = azurerm_resource_group.lab.name
  ttl                 = 300
  records             = [azurerm_network_interface.web.private_ip_address]
  tags                = var.tags
}

# ── The VM: vm-web, registered as vm-web.lab15.internal ──────────────────

resource "azurerm_network_interface" "web" {
  name                = "nic-vm-web"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.vms.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_linux_virtual_machine" "web" {
  name                            = "vm-web"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  size                            = "Standard_B1s"
  admin_username                  = "azureuser"
  admin_password                  = var.admin_password
  disable_password_authentication = false
  network_interface_ids           = [azurerm_network_interface.web.id]
  tags                            = var.tags

  dynamic "admin_ssh_key" {
    for_each = var.ssh_public_key == "" ? [] : [var.ssh_public_key]
    content {
      username   = "azureuser"
      public_key = admin_ssh_key.value
    }
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

  custom_data = base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", { port = 80 }))

  # Linked first, so the VM's own A record is registered when it boots.
  depends_on = [azurerm_private_dns_zone_virtual_network_link.lab]
}
