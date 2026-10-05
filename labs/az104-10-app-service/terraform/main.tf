# main.tf
#
# Plain English: App Service from the plan up. asp-lab is a Linux App
# Service plan on Standard S1, the cheapest tier with both deployment slots
# and autoscale that a new pay-as-you-go subscription can use (Basic has
# neither; Premium v3 has no quota there by default, so an apply of P0v3 is
# refused). On it runs one web app, <prefix>-web, with Node.js 22 as its
# built-in runtime and no code deployed, so it shows the runtime's own
# start page, and a deployment slot, staging, with the same settings. Both
# are https only (TLS 1.2 or later, FTP off). An autoscale setting keeps the
# plan at 1 or 2 instances on average CPU. The app and slot are public
# websites by nature (ruling 5): the lab has no VNet and cannot peer.

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

# ── The plan: what the apps run on, and what you pay for ─────────────────

resource "azurerm_service_plan" "plan" {
  name                = "asp-lab"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  os_type             = "Linux"
  sku_name            = "S1"
  # One instance to start; autoscale may add a second.
  worker_count = 1
  tags         = var.tags
}

# ── The web app and its staging slot ─────────────────────────────────────

resource "azurerm_linux_web_app" "web" {
  name                = "${var.name_prefix}-web"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  service_plan_id     = azurerm_service_plan.plan.id
  https_only          = true
  tags                = var.tags

  site_config {
    always_on           = true
    ftps_state          = "Disabled"
    minimum_tls_version = "1.2"
    http2_enabled       = true

    application_stack {
      node_version = "22-lts"
    }
  }
}

resource "azurerm_linux_web_app_slot" "staging" {
  name           = "staging"
  app_service_id = azurerm_linux_web_app.web.id
  https_only     = true
  tags           = var.tags

  site_config {
    always_on           = true
    ftps_state          = "Disabled"
    minimum_tls_version = "1.2"
    http2_enabled       = true

    application_stack {
      node_version = "22-lts"
    }
  }
}

# ── Autoscale: 1 or 2 plan instances on average CPU ──────────────────────

resource "azurerm_monitor_autoscale_setting" "plan" {
  name                = "autoscale-asp-lab"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  target_resource_id  = azurerm_service_plan.plan.id
  enabled             = true
  tags                = var.tags

  profile {
    name = "cpu"

    capacity {
      default = 1
      minimum = 1
      maximum = 2
    }

    # Scale out: a second instance when average CPU is above 70% for 5 minutes.
    rule {
      metric_trigger {
        metric_name        = "CpuPercentage"
        metric_namespace   = "microsoft.web/serverfarms"
        metric_resource_id = azurerm_service_plan.plan.id
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

    # Scale in: back to one below 25% for 5 minutes.
    rule {
      metric_trigger {
        metric_name        = "CpuPercentage"
        metric_namespace   = "microsoft.web/serverfarms"
        metric_resource_id = azurerm_service_plan.plan.id
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
