# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# No VNet, so no private addresses and nothing to peer. connect names the
# namespace, where to upload a file to raise an event, and the consumer job.
# No key or connection string is ever an output: the portal's Service Bus
# Explorer reads the namespace's keys with your own sign-in.

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "${azurerm_servicebus_namespace.sb.name}.servicebus.windows.net: queues orders and blob-events, topic notifications",
    "${azurerm_storage_account.events.primary_blob_endpoint}uploads: upload a file here to raise a BlobCreated event",
    "${azurerm_container_app_job.consumer.name}: the consumer (Container Apps job, Execution history)",
  ]
}
