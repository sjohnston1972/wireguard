# main.tf
#
# Plain English: a £5 monthly budget on the lab's resource group, with three
# thresholds (50% and 80% of actual spend, 100% of forecast) that alert an
# action group. The action group has no receivers, so nothing is emailed or
# called until you add one yourself.
#
# Scope: the budget lives on rg-lab-<id> and goes with it; this is not a
# governance lab, and Contributor is enough for budgets and action groups.
# The budget starts on the 1st of the month it is deployed in; ignore_changes
# keeps a later plan from trying to move it. The amount is in the billing
# account's currency (pounds for a UK account).

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

resource "azurerm_monitor_action_group" "budget" {
  name                = "lab-${var.lab_id}-budget-alerts"
  resource_group_name = azurerm_resource_group.lab.name
  short_name          = "labbudget"
  enabled             = true
  tags                = var.tags
}

resource "azurerm_consumption_budget_resource_group" "monthly" {
  name              = "lab-${var.lab_id}-monthly"
  resource_group_id = azurerm_resource_group.lab.id
  amount            = 5
  time_grain        = "Monthly"

  time_period {
    start_date = formatdate("YYYY-MM-01'T'00:00:00Z", timestamp())
  }

  notification {
    enabled        = true
    threshold      = 50
    operator       = "GreaterThanOrEqualTo"
    threshold_type = "Actual"
    contact_groups = [azurerm_monitor_action_group.budget.id]
  }

  notification {
    enabled        = true
    threshold      = 80
    operator       = "GreaterThanOrEqualTo"
    threshold_type = "Actual"
    contact_groups = [azurerm_monitor_action_group.budget.id]
  }

  notification {
    enabled        = true
    threshold      = 100
    operator       = "GreaterThanOrEqualTo"
    threshold_type = "Forecasted"
    contact_groups = [azurerm_monitor_action_group.budget.id]
  }

  lifecycle {
    ignore_changes = [time_period]
  }
}
