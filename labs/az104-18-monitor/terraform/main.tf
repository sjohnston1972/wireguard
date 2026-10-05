# main.tf
#
# Plain English: Azure Monitor around one small VM. A Standard_B1s Ubuntu VM
# with no public IP emits its platform metrics (CPU, disk, network) for free.
# The Azure Monitor agent (AMA), signed in with the VM's system-assigned
# identity, sends two performance counters every 60 s and syslog warnings
# and above to a Log Analytics workspace, through one data collection rule.
# The workspace is pay-as-you-go with a 0.05 GB daily cap and the free 30
# days' retention, so ingestion can never run away. Two alerts point at an
# action group with no receivers (nobody is ever notified): a metric alert
# on the VM's CPU and an activity log alert on a VM restart in this group.
# Nothing is written at subscription scope (no diagnostic settings): the
# activity log is read where it already is. Reach the VM over the tunnel when
# peered, or through the portal's serial console or Run command.

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
  # The VM has no public IP; Azure's default outbound access lets the agent
  # reach Azure Monitor without a NAT gateway (which would cost more than
  # the VM).
  default_outbound_access_enabled = true
}

# ── The VM ────────────────────────────────────────────────────────────────

resource "azurerm_network_interface" "vm" {
  name                = "nic-vm-monitor"
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
  name                            = "vm-monitor"
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

  # The agent signs in to Azure Monitor as the VM itself. A data collection
  # rule association is all the permission it needs: no role assignment.
  identity {
    type = "SystemAssigned"
  }

  # Managed boot diagnostics: the portal's serial console works with no
  # storage account of our own.
  boot_diagnostics {}
}

# ── Log Analytics, the agent and the data collection rule ────────────────

resource "azurerm_log_analytics_workspace" "lab" {
  name                = "log-lab"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  sku                 = "PerGB2018"
  # 30 days are included in the price (and the least PerGB2018 keeps).
  retention_in_days = 30
  # At most 50 MB a day is ingested; after that Azure drops data until the
  # next day (UTC). A session sends a few MB.
  daily_quota_gb = 0.05
  tags           = var.tags
}

resource "azurerm_virtual_machine_extension" "ama" {
  name                       = "AzureMonitorLinuxAgent"
  virtual_machine_id         = azurerm_linux_virtual_machine.vm.id
  publisher                  = "Microsoft.Azure.Monitor"
  type                       = "AzureMonitorLinuxAgent"
  type_handler_version       = "1.0"
  auto_upgrade_minor_version = true
  automatic_upgrade_enabled  = true
  tags                       = var.tags
}

resource "azurerm_monitor_data_collection_rule" "vm" {
  name                = "dcr-vm-linux"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  kind                = "Linux"
  description         = "Two performance counters every 60 s and syslog warnings and above, from the lab VM to log-lab."
  tags                = var.tags

  destinations {
    log_analytics {
      name                  = "log-lab"
      workspace_resource_id = azurerm_log_analytics_workspace.lab.id
    }
  }

  data_flow {
    streams      = ["Microsoft-Perf", "Microsoft-Syslog"]
    destinations = ["log-lab"]
  }

  data_sources {
    # Few counters, once a minute: the Perf table stays a few MB a session.
    performance_counter {
      name                          = "perf-basic"
      streams                       = ["Microsoft-Perf"]
      sampling_frequency_in_seconds = 60
      counter_specifiers            = ["Processor(*)\\% Processor Time", "Memory(*)\\% Used Memory"]
    }

    syslog {
      name           = "syslog-warning"
      streams        = ["Microsoft-Syslog"]
      facility_names = ["*"]
      log_levels     = ["Warning", "Error", "Critical", "Alert", "Emergency"]
    }
  }
}

resource "azurerm_monitor_data_collection_rule_association" "vm" {
  name                    = "dcra-vm-monitor"
  target_resource_id      = azurerm_linux_virtual_machine.vm.id
  data_collection_rule_id = azurerm_monitor_data_collection_rule.vm.id
  description             = "Sends vm-monitor's counters and syslog through dcr-vm-linux."
}

# ── Alerts ────────────────────────────────────────────────────────────────

# No receivers: an alert that fires shows in the portal's Alerts page and
# notifies nobody. Add your own email receiver by hand to see one arrive.
resource "azurerm_monitor_action_group" "lab" {
  name                = "ag-lab"
  resource_group_name = azurerm_resource_group.lab.name
  location            = "global"
  short_name          = "lab18"
  enabled             = true
  tags                = var.tags
}

resource "azurerm_monitor_metric_alert" "cpu" {
  name                = "alert-vm-cpu-high"
  resource_group_name = azurerm_resource_group.lab.name
  scopes              = [azurerm_linux_virtual_machine.vm.id]
  description         = "vm-monitor's average CPU is over 80% for 5 minutes."
  severity            = 3
  frequency           = "PT1M"
  window_size         = "PT5M"
  tags                = var.tags

  criteria {
    metric_namespace = "Microsoft.Compute/virtualMachines"
    metric_name      = "Percentage CPU"
    aggregation      = "Average"
    operator         = "GreaterThan"
    threshold        = 80
  }

  action {
    action_group_id = azurerm_monitor_action_group.lab.id
  }
}

# Scoped to the lab's group, never the subscription: only restarts in here.
resource "azurerm_monitor_activity_log_alert" "restart" {
  name                = "alert-vm-restart"
  resource_group_name = azurerm_resource_group.lab.name
  location            = "global"
  scopes              = [azurerm_resource_group.lab.id]
  description         = "A VM in the lab's group was restarted."
  tags                = var.tags

  criteria {
    category       = "Administrative"
    operation_name = "Microsoft.Compute/virtualMachines/restart/action"
  }

  action {
    action_group_id = azurerm_monitor_action_group.lab.id
  }
}
