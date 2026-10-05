# outputs.tf
#
# Plain English: what the dashboard shows once the lab is up (spec §3.4).
# Nothing here has a private address, and the lab cannot peer (no VNet), so
# there is no peer_vnet_id; connect lists the app's and the slot's public
# addresses.

output "private_ips" {
  value = {}
}

output "connect" {
  value = [
    "https://${azurerm_linux_web_app.web.default_hostname}",
    "https://${azurerm_linux_web_app_slot.staging.default_hostname}",
  ]
}
