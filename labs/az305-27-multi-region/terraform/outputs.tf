# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# Everything here is public: open the URLs in a browser. Nothing is private
# and nothing is peered, so private_ips is empty and there is no
# peer_vnet_id.

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "Traffic Manager: http://${azurerm_traffic_manager_profile.lab.fqdn}",
    "Front Door: https://${azurerm_cdn_frontdoor_endpoint.lab.host_name}   # the edge can take minutes to serve it",
    "ci-uks (${azurerm_resource_group.lab.location}): http://${azurerm_container_group.uks.fqdn}",
    "ci-ukw (${azurerm_resource_group.secondary.location}): http://${azurerm_container_group.ukw.fqdn}",
  ]
}
