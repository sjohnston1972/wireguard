# main.tf
#
# Plain English: a Virtual Machine Scale Set that grows and shrinks on its
# own. vmss-web is a Uniform scale set of Standard_B1s Ubuntu 24.04
# instances with no public IP, starting at 2. Each instance serves its own
# name on port 80 with python3 from a cloud-init systemd unit
# (cloud-init.yaml): nothing is installed. Upgrade mode is Manual, so a model
# change reaches existing instances only when you upgrade them. An autoscale
# setting keeps 1 to 3 instances: one more when the average CPU over 5
# minutes is above 70%, one fewer below 25%. With nothing to do it soon
# scales in to 1. Reach the instances over the tunnel when peered, or
# through each instance's serial console or Run command in the portal.

locals {
  # The first /20 of the slot; the instances' subnet is its first /24.
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
  # No public IPs; the page needs no internet, but Azure's default outbound
  # access is kept on (as lab 7) so apt works if you try it.
  default_outbound_access_enabled = true
}

# ── The scale set ─────────────────────────────────────────────────────────

resource "azurerm_linux_virtual_machine_scale_set" "web" {
  name                = "vmss-web"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  sku                 = "Standard_B1s"
  instances           = 2
  # Manual: a change to the model waits until you upgrade each instance.
  upgrade_mode = "Manual"
  # No extra instances while scaling out (Azure would otherwise build a few
  # spares and delete them), so quota and cost stay as priced.
  overprovision                   = false
  admin_username                  = "azureuser"
  admin_password                  = var.admin_password
  disable_password_authentication = false
  custom_data                     = filebase64("${path.module}/cloud-init.yaml")
  tags                            = var.tags

  dynamic "admin_ssh_key" {
    for_each = var.ssh_public_key == "" ? [] : [var.ssh_public_key]
    content {
      username   = "azureuser"
      public_key = admin_ssh_key.value
    }
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
  }

  network_interface {
    name    = "nic-vmss-web"
    primary = true

    ip_configuration {
      name      = "ipconfig1"
      primary   = true
      subnet_id = azurerm_subnet.vms.id
    }
  }

  # Managed boot diagnostics: each instance's serial console works.
  boot_diagnostics {}

  lifecycle {
    # Autoscale owns the instance count once the lab is up.
    ignore_changes = [instances]
  }
}

# ── Autoscale: 1 to 3 instances on average CPU ───────────────────────────

resource "azurerm_monitor_autoscale_setting" "web" {
  name                = "autoscale-vmss-web"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  target_resource_id  = azurerm_linux_virtual_machine_scale_set.web.id
  enabled             = true
  tags                = var.tags

  profile {
    name = "cpu"

    capacity {
      default = 2
      minimum = 1
      maximum = 3
    }

    # Scale out: one more instance when average CPU is above 70% for 5 minutes.
    rule {
      metric_trigger {
        metric_name        = "Percentage CPU"
        metric_namespace   = "microsoft.compute/virtualmachinescalesets"
        metric_resource_id = azurerm_linux_virtual_machine_scale_set.web.id
        time_grain         = "PT1M"
        statistic          = "Average"
        time_window        = "PT5M"
        time_aggregation   = "Average"
        operator           = "GreaterThan"
        threshold          = 70
      }

      scale_action {
        direction = "Increase"
        type      = "ChangeCount"
        value     = "1"
        cooldown  = "PT5M"
      }
    }

    # Scale in: one fewer when average CPU is below 25% for 5 minutes.
    rule {
      metric_trigger {
        metric_name        = "Percentage CPU"
        metric_namespace   = "microsoft.compute/virtualmachinescalesets"
        metric_resource_id = azurerm_linux_virtual_machine_scale_set.web.id
        time_grain         = "PT1M"
        statistic          = "Average"
        time_window        = "PT5M"
        time_aggregation   = "Average"
        operator           = "LessThan"
        threshold          = 25
      }

      scale_action {
        direction = "Decrease"
        type      = "ChangeCount"
        value     = "1"
        cooldown  = "PT5M"
      }
    }
  }
}
