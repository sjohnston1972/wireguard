# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# Front Door's endpoint is the only way in: open it in a browser once you
# have approved its connection on pls-web. The lab is never peered, so
# there is no peer_vnet_id; the private addresses are for reading.

output "private_ips" {
  value = {
    "vm-web" = azurerm_network_interface.web.private_ip_address
    "lb-int" = local.lb_ip
  }
}

output "connect" {
  value = [
    "https://${azurerm_cdn_frontdoor_endpoint.lab.host_name}   # 502 until you approve Front Door's connection on pls-web",
    "curl -sI https://${azurerm_cdn_frontdoor_endpoint.lab.host_name}/static/hello.txt   # x-cache: TCP_HIT on the second try",
    "curl -sI https://${azurerm_cdn_frontdoor_endpoint.lab.host_name}/old   # 301 to /",
    "az network private-link-service show -g ${azurerm_resource_group.lab.name} -n pls-web --query privateEndpointConnections",
  ]
}
