# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# The listener always names the primary; the servers' own names are there
# to compare. Over the tunnel (peered) they resolve to the private
# endpoints; peer_vnet_id is the VNet the pipeline peers to the gateway.

output "private_ips" {
  value = {
    "pe-sqlp" = azurerm_private_endpoint.primary.private_service_connection[0].private_ip_address
    "pe-sqls" = azurerm_private_endpoint.secondary.private_service_connection[0].private_ip_address
  }
}

output "connect" {
  value = [
    "sqlcmd -S tcp:${azurerm_mssql_failover_group.fog.name}.database.windows.net,1433 -d appdb -U labadmin",
    "nslookup ${azurerm_mssql_failover_group.fog.name}.database.windows.net",
    "nslookup ${azurerm_mssql_server.primary.fully_qualified_domain_name}",
    "nslookup ${azurerm_mssql_server.secondary.fully_qualified_domain_name}",
    "sqlcmd -S tcp:${azurerm_mssql_server.secondary.fully_qualified_domain_name},1433 -d scratch -U labadmin",
  ]
}

output "peer_vnet_id" {
  value = azurerm_virtual_network.lab.id
}
