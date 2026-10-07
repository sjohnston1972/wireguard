# main.tf
#
# Plain English: messaging and events on Azure, with an event-driven
# consumer and no App Service (the subscription's App Service quota is 0, and
# every Functions hosting plan is an App Service plan: spec §17, lab 30's
# ruling).
#
#   sb-<prefix>      Service Bus namespace, Standard (topics and
#                    subscriptions need Standard; Basic has queues only).
#                    Queues orders and blob-events: 30-second lock, five
#                    deliveries, then the dead-letter queue. Topic
#                    notifications with subscriptions all and high-priority
#                    (a SQL filter, priority = 'high').
#   <prefix>evt      Storage account. Event Grid's system topic on it sends
#                    BlobCreated and BlobDeleted events for the uploads
#                    container to the blob-events queue, and dead-letters
#                    what it cannot deliver to eventgrid-deadletter.
#   caj-consumer     A Container Apps job in a consumption-only environment
#                    (no subnet, so no ME_ group: ruling 7). KEDA's
#                    azure-servicebus scaler starts a run when either queue
#                    holds a message; each run (consumer.py, on Microsoft's
#                    Python image from MCR) peek-locks and completes every
#                    message, and leaves any message whose body says "fail"
#                    locked, so Service Bus delivers it again until it is
#                    dead-lettered. Its console goes to log-lab (capped).
#
# Keys: no Service Bus data role is on the labs' allow-list, so nothing uses
# a managed identity. Two shared access policies on the namespace are held
# as Container Apps secrets: consumer (Listen only) for the script, and
# scaler (Manage, which KEDA needs to read a queue's length). No key or
# connection string is ever an output.

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

# ── Service Bus ──────────────────────────────────────────────────────────

resource "azurerm_servicebus_namespace" "sb" {
  name                          = "sb-${var.name_prefix}"
  resource_group_name           = azurerm_resource_group.lab.name
  location                      = azurerm_resource_group.lab.location
  sku                           = "Standard"
  minimum_tls_version           = "1.2"
  local_auth_enabled            = true
  public_network_access_enabled = true
  tags                          = var.tags
}

# Work items: one consumer takes each message once.
resource "azurerm_servicebus_queue" "orders" {
  name                                 = "orders"
  namespace_id                         = azurerm_servicebus_namespace.sb.id
  lock_duration                        = "PT30S"
  max_delivery_count                   = 5
  default_message_ttl                  = "PT1H"
  dead_lettering_on_message_expiration = true
}

# Event Grid's blob events land here.
resource "azurerm_servicebus_queue" "blob_events" {
  name                                 = "blob-events"
  namespace_id                         = azurerm_servicebus_namespace.sb.id
  lock_duration                        = "PT30S"
  max_delivery_count                   = 5
  default_message_ttl                  = "PT1H"
  dead_lettering_on_message_expiration = true
}

# Publish and subscribe: every subscription gets its own copy of a message
# that passes its filter.
resource "azurerm_servicebus_topic" "notifications" {
  name                = "notifications"
  namespace_id        = azurerm_servicebus_namespace.sb.id
  default_message_ttl = "PT1H"
}

resource "azurerm_servicebus_subscription" "all" {
  name                                 = "all"
  topic_id                             = azurerm_servicebus_topic.notifications.id
  max_delivery_count                   = 5
  dead_lettering_on_message_expiration = true
}

resource "azurerm_servicebus_subscription" "high_priority" {
  name                                 = "high-priority"
  topic_id                             = azurerm_servicebus_topic.notifications.id
  max_delivery_count                   = 5
  dead_lettering_on_message_expiration = true
}

# Azure also gives every new subscription a $Default rule that lets
# everything through, and rules are ORed, so high-priority still gets every
# message until $Default is deleted (Things to try). Terraform cannot take
# over $Default; it only adds this rule.
resource "azurerm_servicebus_subscription_rule" "high_priority" {
  name            = "priority-high"
  subscription_id = azurerm_servicebus_subscription.high_priority.id
  filter_type     = "SqlFilter"
  sql_filter      = "priority = 'high'"
}

# The consumer's key: Listen only.
resource "azurerm_servicebus_namespace_authorization_rule" "consumer" {
  name         = "consumer"
  namespace_id = azurerm_servicebus_namespace.sb.id
  listen       = true
  send         = false
  manage       = false
}

# KEDA's key: reading a queue's message count is a management call, which
# needs Manage (and Azure requires Listen and Send with Manage).
resource "azurerm_servicebus_namespace_authorization_rule" "scaler" {
  name         = "scaler"
  namespace_id = azurerm_servicebus_namespace.sb.id
  listen       = true
  send         = true
  manage       = true
}

# ── Event Grid: blob events to the blob-events queue ─────────────────────

resource "azurerm_storage_account" "events" {
  name                            = "${var.name_prefix}evt"
  resource_group_name             = azurerm_resource_group.lab.name
  location                        = azurerm_resource_group.lab.location
  account_kind                    = "StorageV2"
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  access_tier                     = "Hot"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = true
  public_network_access_enabled   = true
  tags                            = var.tags
}

resource "azurerm_storage_container" "uploads" {
  name                  = "uploads"
  storage_account_id    = azurerm_storage_account.events.id
  container_access_type = "private"
}

resource "azurerm_storage_container" "deadletter" {
  name                  = "eventgrid-deadletter"
  storage_account_id    = azurerm_storage_account.events.id
  container_access_type = "private"
}

resource "azurerm_eventgrid_system_topic" "storage" {
  name                = "egst-storage"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  topic_type          = "Microsoft.Storage.StorageAccounts"
  source_resource_id  = azurerm_storage_account.events.id
  tags                = var.tags
}

resource "azurerm_eventgrid_system_topic_event_subscription" "blob_to_queue" {
  name                          = "blob-to-queue"
  system_topic                  = azurerm_eventgrid_system_topic.storage.name
  resource_group_name           = azurerm_resource_group.lab.name
  service_bus_queue_endpoint_id = azurerm_servicebus_queue.blob_events.id
  included_event_types          = ["Microsoft.Storage.BlobCreated", "Microsoft.Storage.BlobDeleted"]

  # Only the uploads container: what Event Grid dead-letters into this same
  # account must never raise events of its own.
  subject_filter {
    subject_begins_with = "/blobServices/default/containers/uploads/"
  }

  retry_policy {
    max_delivery_attempts = 5
    event_time_to_live    = 60
  }

  storage_blob_dead_letter_destination {
    storage_account_id          = azurerm_storage_account.events.id
    storage_blob_container_name = azurerm_storage_container.deadletter.name
  }
}

# ── The consumer: a Container Apps job, started by KEDA ──────────────────

resource "azurerm_log_analytics_workspace" "lab" {
  name                = "log-lab"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  daily_quota_gb      = 0.05
  tags                = var.tags
}

resource "azurerm_container_app_environment" "lab" {
  name                       = "cae-lab"
  resource_group_name        = azurerm_resource_group.lab.name
  location                   = azurerm_resource_group.lab.location
  logs_destination           = "log-analytics"
  log_analytics_workspace_id = azurerm_log_analytics_workspace.lab.id
  tags                       = var.tags
}

resource "azurerm_container_app_job" "consumer" {
  name                         = "caj-consumer"
  resource_group_name          = azurerm_resource_group.lab.name
  location                     = azurerm_resource_group.lab.location
  container_app_environment_id = azurerm_container_app_environment.lab.id
  replica_timeout_in_seconds   = 120
  # A failed run is not retried: the message's own redelivery is the retry.
  replica_retry_limit = 0
  tags                = var.tags

  secret {
    name  = "sb-listen"
    value = azurerm_servicebus_namespace_authorization_rule.consumer.primary_connection_string
  }

  secret {
    name  = "sb-scaler"
    value = azurerm_servicebus_namespace_authorization_rule.scaler.primary_connection_string
  }

  event_trigger_config {
    parallelism              = 1
    replica_completion_count = 1

    scale {
      min_executions              = 0
      max_executions              = 2
      polling_interval_in_seconds = 30

      rules {
        name             = "orders"
        custom_rule_type = "azure-servicebus"
        metadata = {
          queueName    = azurerm_servicebus_queue.orders.name
          namespace    = azurerm_servicebus_namespace.sb.name
          messageCount = "1"
        }

        authentication {
          secret_name       = "sb-scaler"
          trigger_parameter = "connection"
        }
      }

      rules {
        name             = "blob-events"
        custom_rule_type = "azure-servicebus"
        metadata = {
          queueName    = azurerm_servicebus_queue.blob_events.name
          namespace    = azurerm_servicebus_namespace.sb.name
          messageCount = "1"
        }

        authentication {
          secret_name       = "sb-scaler"
          trigger_parameter = "connection"
        }
      }
    }
  }

  template {
    container {
      name   = "consumer"
      image  = "mcr.microsoft.com/azurelinux/base/python:3.12"
      cpu    = 0.25
      memory = "0.5Gi"
      # The script (Python's standard library only) is passed on the command
      # line, so there is no image to build and no registry.
      command = ["python3", "-c", file("${path.module}/consumer.py")]

      env {
        name        = "SB_CONNECTION"
        secret_name = "sb-listen"
      }

      env {
        name  = "QUEUES"
        value = "${azurerm_servicebus_queue.orders.name},${azurerm_servicebus_queue.blob_events.name}"
      }
    }
  }
}
