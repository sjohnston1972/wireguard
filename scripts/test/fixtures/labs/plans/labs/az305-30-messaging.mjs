// az305-30-messaging.mjs
//
// Plain English: lab 30's first-deploy plan, written out from
// labs/az305-30-messaging/terraform/main.tf with a real session's values
// (slot 1, prefix l30k3x9q), as `terraform show -json` prints it
// (realistic.mjs adds what azurerm 4.81.0 computes and marks every attribute
// its schema calls sensitive: the authorization rules' keys and connection
// strings, the namespace's default ones; the job's secret block as a whole,
// SENSITIVE_BLOCKS) and plans the namespace's unset network_rule_set as
// unknown (UNSET_BLOCKS_UNKNOWN), as the first release test recorded.
//
// Known at plan: every name (the system topic's, which the event
// subscription names, and the queues' and namespace's, which the job's KEDA
// metadata and QUEUES name), and the job's command (file() of consumer.py
// is read at plan). Unknown: every id, and the two secrets' values (the
// policies' connection strings exist only after apply). The job's secret
// block is a set: Terraform prints each element with its value unknown.

import { readFileSync } from "node:fs";
import { ctx, IN_RG, ref, REGION, rgResource } from "../common.mjs";

const SCRIPT = readFileSync(new URL("../../../../../../labs/az305-30-messaging/terraform/consumer.py", import.meta.url), "utf8");

export default () => {
  const c = ctx("az305-30-messaging", "30");
  const ns = "azurerm_servicebus_namespace.sb";
  const nsName = `sb-${c.prefix}`;
  const queue = (key, name) => ({
    address: `azurerm_servicebus_queue.${key}`,
    values: { name, lock_duration: "PT30S", max_delivery_count: 5, default_message_ttl: "PT1H", dead_lettering_on_message_expiration: true },
    unknown: ["namespace_id"],
    refs: { namespace_id: ref(ns, "id") },
  });
  const subscription = (key, name) => ({
    address: `azurerm_servicebus_subscription.${key}`,
    values: { name, max_delivery_count: 5, dead_lettering_on_message_expiration: true },
    unknown: ["topic_id"],
    refs: { topic_id: ref("azurerm_servicebus_topic.notifications", "id") },
  });
  const policy = (key, listen, send, manage) => ({
    address: `azurerm_servicebus_namespace_authorization_rule.${key}`,
    values: { name: key, listen, send, manage },
    unknown: ["namespace_id"],
    refs: { namespace_id: ref(ns, "id") },
  });
  const container = (key, name) => ({
    address: `azurerm_storage_container.${key}`,
    values: { name, container_access_type: "private" },
    unknown: ["storage_account_id"],
    refs: { storage_account_id: ref("azurerm_storage_account.events", "id") },
  });
  const rule = (name, queueKey, queueName) => ({
    name,
    custom_rule_type: "azure-servicebus",
    metadata: { queueName, namespace: nsName, messageCount: "1" },
    authentication: [{ secret_name: "sb-scaler", trigger_parameter: "connection" }],
    _refs: [...ref(`azurerm_servicebus_queue.${queueKey}`, "name"), ...ref(ns, "name")],
  });
  const rules = [rule("orders", "orders", "orders"), rule("blob-events", "blob_events", "blob-events")];
  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      // ── Service Bus ──
      {
        address: ns,
        values: { name: nsName, resource_group_name: c.rg, location: REGION, sku: "Standard", minimum_tls_version: "1.2", local_auth_enabled: true, public_network_access_enabled: true, tags: c.tags },
        refs: { ...IN_RG, name: ["var.name_prefix"] },
      },
      queue("orders", "orders"),
      queue("blob_events", "blob-events"),
      {
        address: "azurerm_servicebus_topic.notifications",
        values: { name: "notifications", default_message_ttl: "PT1H" },
        unknown: ["namespace_id"],
        refs: { namespace_id: ref(ns, "id") },
      },
      subscription("all", "all"),
      subscription("high_priority", "high-priority"),
      {
        address: "azurerm_servicebus_subscription_rule.high_priority",
        values: { name: "priority-high", filter_type: "SqlFilter", sql_filter: "priority = 'high'" },
        unknown: ["subscription_id"],
        refs: { subscription_id: ref("azurerm_servicebus_subscription.high_priority", "id") },
      },
      policy("consumer", true, false, false),
      policy("scaler", true, true, true),
      // ── Event Grid ──
      {
        address: "azurerm_storage_account.events",
        values: {
          name: `${c.prefix}evt`,
          resource_group_name: c.rg,
          location: REGION,
          account_kind: "StorageV2",
          account_tier: "Standard",
          account_replication_type: "LRS",
          access_tier: "Hot",
          min_tls_version: "TLS1_2",
          https_traffic_only_enabled: true,
          allow_nested_items_to_be_public: false,
          shared_access_key_enabled: true,
          public_network_access_enabled: true,
          tags: c.tags,
        },
        refs: { ...IN_RG, name: ["var.name_prefix"] },
      },
      container("uploads", "uploads"),
      container("deadletter", "eventgrid-deadletter"),
      {
        address: "azurerm_eventgrid_system_topic.storage",
        values: { name: "egst-storage", resource_group_name: c.rg, location: REGION, topic_type: "Microsoft.Storage.StorageAccounts", tags: c.tags },
        unknown: ["source_resource_id"],
        refs: { ...IN_RG, source_resource_id: ref("azurerm_storage_account.events", "id") },
      },
      {
        address: "azurerm_eventgrid_system_topic_event_subscription.blob_to_queue",
        values: {
          name: "blob-to-queue",
          system_topic: "egst-storage",
          resource_group_name: c.rg,
          included_event_types: ["Microsoft.Storage.BlobCreated", "Microsoft.Storage.BlobDeleted"],
          subject_filter: [{ subject_begins_with: "/blobServices/default/containers/uploads/" }],
          retry_policy: [{ max_delivery_attempts: 5, event_time_to_live: 60 }],
          storage_blob_dead_letter_destination: [{ storage_blob_container_name: "eventgrid-deadletter" }],
        },
        unknown: ["service_bus_queue_endpoint_id", "storage_blob_dead_letter_destination.0.storage_account_id"],
        refs: {
          resource_group_name: IN_RG.resource_group_name,
          system_topic: ref("azurerm_eventgrid_system_topic.storage", "name"),
          service_bus_queue_endpoint_id: ref("azurerm_servicebus_queue.blob_events", "id"),
          "storage_blob_dead_letter_destination.0.storage_account_id": ref("azurerm_storage_account.events", "id"),
          "storage_blob_dead_letter_destination.0.storage_blob_container_name": ref("azurerm_storage_container.deadletter", "name"),
        },
      },
      // ── The consumer ──
      {
        address: "azurerm_log_analytics_workspace.lab",
        values: { name: "log-lab", resource_group_name: c.rg, location: REGION, sku: "PerGB2018", retention_in_days: 30, daily_quota_gb: 0.05, tags: c.tags },
        refs: IN_RG,
      },
      {
        address: "azurerm_container_app_environment.lab",
        values: { name: "cae-lab", resource_group_name: c.rg, location: REGION, logs_destination: "log-analytics", tags: c.tags },
        unknown: ["log_analytics_workspace_id"],
        refs: { ...IN_RG, log_analytics_workspace_id: ref("azurerm_log_analytics_workspace.lab", "id") },
      },
      {
        address: "azurerm_container_app_job.consumer",
        values: {
          name: "caj-consumer",
          resource_group_name: c.rg,
          location: REGION,
          replica_timeout_in_seconds: 120,
          replica_retry_limit: 0,
          tags: c.tags,
          secret: [{ name: "sb-listen" }, { name: "sb-scaler" }],
          event_trigger_config: [
            {
              parallelism: 1,
              replica_completion_count: 1,
              scale: [{ min_executions: 0, max_executions: 2, polling_interval_in_seconds: 30, rules: rules.map(({ _refs, ...r }) => r) }],
            },
          ],
          template: [
            {
              container: [
                {
                  name: "consumer",
                  image: "mcr.microsoft.com/azurelinux/base/python:3.12",
                  cpu: 0.25,
                  memory: "0.5Gi",
                  command: ["python3", "-c", SCRIPT],
                  env: [
                    { name: "SB_CONNECTION", secret_name: "sb-listen" },
                    { name: "QUEUES", value: "orders,blob-events" },
                  ],
                },
              ],
            },
          ],
        },
        unknown: ["container_app_environment_id", "secret.0.value", "secret.1.value"],
        refs: {
          ...IN_RG,
          container_app_environment_id: ref("azurerm_container_app_environment.lab", "id"),
          "secret.0.value": ref("azurerm_servicebus_namespace_authorization_rule.consumer", "primary_connection_string"),
          "secret.1.value": ref("azurerm_servicebus_namespace_authorization_rule.scaler", "primary_connection_string"),
          "event_trigger_config.0.scale.0.rules.0.metadata": rules[0]._refs,
          "event_trigger_config.0.scale.0.rules.1.metadata": rules[1]._refs,
          "template.0.container.0.command": ["path.module"],
          "template.0.container.0.env.1.value": [...ref("azurerm_servicebus_queue.orders", "name"), ...ref("azurerm_servicebus_queue.blob_events", "name")],
        },
      },
    ],
  };
};
