# main.tf
#
# Plain English: this is the whole Azure build, top to bottom, in the order a
# network engineer would rack it: a resource group (the rack), a VNet and
# subnet (the LAN), a security group (the firewall), a public IP (the WAN
# address), a NIC, and finally the VM itself (the headend). Last, the DNS
# record that points wg.clydeford.net at the new WAN address.
#
# Every resource is created by "apply" and removed by "destroy". Nothing here
# survives a destroy, which is exactly why the bill returns to zero.

locals {
  peers         = jsondecode(var.peers_json)
  wg_server_ip  = cidrhost(var.wg_subnet, 1)
  wg_prefix_len = split("/", var.wg_subnet)[1]
  ipv6          = var.wg_subnet6 != ""
  # The VM's IPv6 subnet is the second /64 of the VNet's /48 (fd50:50:0:1::/64),
  # derived rather than typed so it can never fall outside the VNet.
  subnet_cidr6 = cidrsubnet(var.vnet_cidr6, 16, 1)
  # IPv6 inside the tunnel mirrors IPv4: 10.13.13.7 is fd13:13::7. The
  # dashboard derives the same address, so the two always agree.
  wg_server_ip6 = local.ipv6 ? cidrhost(var.wg_subnet6, 1) : ""
  peer_ip6      = { for p in local.peers : p.ip => local.ipv6 ? cidrhost(var.wg_subnet6, tonumber(split(".", p.ip)[3])) : "" }
  common_tags = {
    project = "wg-admin"
    run_id  = var.run_id
    managed = "terraform"
  }

  # The [Peer] half of wg0.conf, one block per client. Pre-rendered here so the
  # YAML template only has to drop it in with the right indentation.
  peers_conf = length(local.peers) == 0 ? "# no peers yet\n" : join("\n", [
    for p in local.peers :
    "# ${p.name}\n[Peer]\nPublicKey = ${p.public_key}\nAllowedIPs = ${p.ip}/32${local.ipv6 ? ",${local.peer_ip6[p.ip]}/128" : ""}\n"
  ])

  # The VM's zero-touch provisioning script.
  cloud_init = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    wg_server_private_key = var.wg_server_private_key
    wg_server_ip          = local.wg_server_ip
    wg_prefix_len         = local.wg_prefix_len
    wg_server_ip6         = local.wg_server_ip6
    wg_prefix_len6        = local.ipv6 ? split("/", var.wg_subnet6)[1] : ""
    wg_port               = var.wg_port
    loopback_ip           = var.loopback_ip
    ssh_password          = var.ssh_password
    peers_conf            = local.peers_conf
    agent_url             = var.agent_url
    agent_token           = var.agent_token
    agent_script          = file("${path.module}/agent/wg-agent.sh")
    agent_service         = file("${path.module}/agent/wg-agent.service")
    agent_timer           = file("${path.module}/agent/wg-agent.timer")
    selftest_script       = file("${path.module}/agent/wg-selftest.sh")
    selftest_service      = file("${path.module}/agent/wg-selftest.service")
    blocklist_script      = file("${path.module}/agent/wg-blocklist.sh")
    blocklist_service     = file("${path.module}/agent/wg-blocklist.service")
  })
}

# ── The rack ────────────────────────────────────────────────────────────────

resource "azurerm_resource_group" "wg" {
  name     = var.resource_group
  location = var.region
  tags     = local.common_tags
}

# ── The LAN ─────────────────────────────────────────────────────────────────

resource "azurerm_virtual_network" "wg" {
  name                = "vnet-wg"
  location            = azurerm_resource_group.wg.location
  resource_group_name = azurerm_resource_group.wg.name
  address_space       = compact([var.vnet_cidr, local.ipv6 ? var.vnet_cidr6 : ""])
  tags                = local.common_tags
}

resource "azurerm_subnet" "wg" {
  name                 = "snet-wg"
  resource_group_name  = azurerm_resource_group.wg.name
  virtual_network_name = azurerm_virtual_network.wg.name
  address_prefixes     = compact([var.subnet_cidr, local.ipv6 ? local.subnet_cidr6 : ""])
}

# ── The firewall ────────────────────────────────────────────────────────────
# Deny-by-default inbound. Two holes: WireGuard from anywhere, SSH from the
# allow-list (only if one was given). Outbound is left open so the VM can
# fetch packages and report to the Worker.

resource "azurerm_network_security_group" "wg" {
  name                = "nsg-wg"
  location            = azurerm_resource_group.wg.location
  resource_group_name = azurerm_resource_group.wg.name
  tags                = local.common_tags

  security_rule {
    name                       = "allow-wireguard"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Udp"
    source_port_range          = "*"
    destination_port_range     = tostring(var.wg_port)
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  dynamic "security_rule" {
    for_each = var.ssh_allowed_cidr == "" ? [] : [var.ssh_allowed_cidr]
    content {
      name                       = "allow-ssh-from-home"
      priority                   = 110
      direction                  = "Inbound"
      access                     = "Allow"
      protocol                   = "Tcp"
      source_port_range          = "*"
      destination_port_range     = "22"
      source_address_prefix      = security_rule.value
      destination_address_prefix = "*"
    }
  }

  security_rule {
    name                       = "deny-all-inbound"
    priority                   = 4000
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "wg" {
  subnet_id                 = azurerm_subnet.wg.id
  network_security_group_id = azurerm_network_security_group.wg.id
}

# ── The WAN address ─────────────────────────────────────────────────────────
# Static for the life of the VM so DNS is written once per deploy. It is
# destroyed with everything else; the stable identity is the DNS name.

resource "azurerm_public_ip" "wg" {
  name                = "pip-wg"
  location            = azurerm_resource_group.wg.location
  resource_group_name = azurerm_resource_group.wg.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = local.common_tags
}

# IPv6 WAN address, so full-tunnel clients get IPv6 to the internet instead
# of having it silently dropped. Azure does not charge for IPv6 addresses.
resource "azurerm_public_ip" "wg6" {
  count               = local.ipv6 ? 1 : 0
  name                = "pip-wg-v6"
  location            = azurerm_resource_group.wg.location
  resource_group_name = azurerm_resource_group.wg.name
  allocation_method   = "Static"
  sku                 = "Standard"
  ip_version          = "IPv6"
  tags                = local.common_tags
}

resource "azurerm_network_interface" "wg" {
  name                = "nic-wg"
  location            = azurerm_resource_group.wg.location
  resource_group_name = azurerm_resource_group.wg.name
  tags                = local.common_tags

  # Without this Azure silently drops packets the VM forwards between the
  # tunnel and the VNet. It is the cloud equivalent of "ip routing" on a switch.
  ip_forwarding_enabled = true

  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.wg.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.wg.id
    primary                       = true
  }

  dynamic "ip_configuration" {
    for_each = local.ipv6 ? [1] : []
    content {
      name                          = "ipv6"
      subnet_id                     = azurerm_subnet.wg.id
      private_ip_address_version    = "IPv6"
      private_ip_address_allocation = "Dynamic"
      public_ip_address_id          = azurerm_public_ip.wg6[0].id
    }
  }
}

# ── The headend ─────────────────────────────────────────────────────────────

resource "azurerm_linux_virtual_machine" "wg" {
  name                = "vm-wg"
  location            = azurerm_resource_group.wg.location
  resource_group_name = azurerm_resource_group.wg.name
  size                = var.vm_size
  admin_username      = "azureuser"
  tags                = local.common_tags

  network_interface_ids = [azurerm_network_interface.wg.id]

  disable_password_authentication = true
  admin_ssh_key {
    username   = "azureuser"
    public_key = var.ssh_public_key
  }

  os_disk {
    name                 = "osdisk-wg"
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
    disk_size_gb         = 30
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "server"
    version   = "latest"
  }

  # cloud-init: the VM configures itself on first boot. See cloud-init.yaml.tftpl.
  custom_data = base64encode(local.cloud_init)
}

# ── Optional: route home LAN via the VM ─────────────────────────────────────
# Only when home_lan_cidr is set. Lets future Azure workloads in this VNet
# reach 192.168.1.0/24 through the tunnel, like a static route on a core switch
# pointing at the VPN concentrator.

resource "azurerm_route_table" "home" {
  count               = var.home_lan_cidr == "" ? 0 : 1
  name                = "rt-wg-home"
  location            = azurerm_resource_group.wg.location
  resource_group_name = azurerm_resource_group.wg.name
  tags                = local.common_tags

  route {
    name                   = "to-home-lan"
    address_prefix         = var.home_lan_cidr
    next_hop_type          = "VirtualAppliance"
    next_hop_in_ip_address = azurerm_network_interface.wg.private_ip_address
  }
}

resource "azurerm_subnet_route_table_association" "home" {
  count          = var.home_lan_cidr == "" ? 0 : 1
  subnet_id      = azurerm_subnet.wg.id
  route_table_id = azurerm_route_table.home[0].id
}

# ── DNS: the stable name ────────────────────────────────────────────────────
# Grey cloud (proxied = false) is mandatory: Cloudflare's proxy only carries
# HTTP, and WireGuard is UDP. TTL 60 so clients pick up a new address within a
# minute of a rebuild.

resource "cloudflare_dns_record" "wg" {
  zone_id = var.cloudflare_zone_id
  name    = var.wg_dns_name
  type    = "A"
  content = azurerm_public_ip.wg.ip_address
  ttl     = 60
  proxied = false
  comment = "Managed by wg-admin Terraform. Do not edit by hand."
}
