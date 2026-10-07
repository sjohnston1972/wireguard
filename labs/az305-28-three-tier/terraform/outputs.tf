# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# Front Door is the way in; the web tier's own URL is there to show it is
# refused. The private endpoint's address is the only private one, reached
# from inside the environment (the lab is never peered). Nothing here holds
# the password: it lives behind Show and in the app tier's secret.

output "private_ips" {
  value = {
    "pe-sql" = azurerm_private_endpoint.sql.private_service_connection[0].private_ip_address
  }
}

output "connect" {
  value = [
    "Front Door (the way in): https://${azurerm_cdn_frontdoor_endpoint.lab.host_name}   # the edge can take minutes to serve it",
    "Web tier direct, refused with 403: https://${azurerm_container_app.web.ingress[0].fqdn}",
    "WAF custom rule, blocked with 403: https://${azurerm_cdn_frontdoor_endpoint.lab.host_name}/admin",
    "sqlcmd from the app tier: az containerapp exec -g ${azurerm_resource_group.lab.name} -n ca-app --container sqltools --command bash",
  ]
}
