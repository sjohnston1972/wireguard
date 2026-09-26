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
  # Only peers with a proper WireGuard key and a plain IPv4 address get into
  # wg0.conf (the dashboard checks the same; this is the second lock).
  peers = [
    for p in jsondecode(var.peers_json) : p
    if can(regex("^[A-Za-z0-9+/]{43}=$", p.public_key)) && can(regex("^[0-9]{1,3}(\\.[0-9]{1,3}){3}$", p.ip))
  ]
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
  # YAML template only has to drop it in with the right indentation. A site
  # peer (the home container) also lists its LAN ("routes"); wg-quick then
  # adds the matching kernel route when the tunnel comes up. The name goes in
  # a comment line, so anything but plain characters becomes "?": a line
  # break in a name must never be able to add a line of its own.
  # A site route wider than /8 (0.0.0.0/0, say) would take over the VM's own
  # internet route at boot and cut it off from the dashboard for good, and
  # one over the tunnel, loopback or VNet would break those. So only /8 to
  # /32 IPv4 networks that overlap none of them get through. (The dashboard
  # already refuses the rest; this is the second lock.) Two networks overlap
  # when they agree on the shorter of their two prefix lengths.
  route_keep_out = [var.wg_subnet, "${var.loopback_ip}/32", var.vnet_cidr]
  site_routes = { for p in local.peers : p.ip => join(",", [
    for r in [for x in split(",", try(p.routes, "")) : trimspace(x)] : r
    if can(regex("^[0-9]{1,3}(\\.[0-9]{1,3}){3}/([89]|[12][0-9]|3[0-2])$", r)) && can(cidrhost(r, 0)) && !anytrue([
      for k in local.route_keep_out :
      cidrhost("${split("/", r)[0]}/${min(split("/", r)[1], split("/", k)[1])}", 0) == cidrhost("${split("/", k)[0]}/${min(split("/", r)[1], split("/", k)[1])}", 0)
    ])
  ]) }
  peers_conf = length(local.peers) == 0 ? "# no peers yet\n" : join("\n", [
    for p in local.peers :
    "# ${replace(p.name, "/[^A-Za-z0-9 _.-]/", "?")}\n[Peer]\nPublicKey = ${p.public_key}\nAllowedIPs = ${p.ip}/32${local.ipv6 ? ",${local.peer_ip6[p.ip]}/128" : ""}${local.site_routes[p.ip] != "" ? ",${local.site_routes[p.ip]}" : ""}\n"
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
    speedtest_script      = file("${path.module}/agent/wg-speedtest.sh")
    capture_script        = file("${path.module}/agent/wg-capture.sh")
    firewall_load_script  = file("${path.module}/agent/wg-firewall-load.sh")
    vnet_cidr             = var.vnet_cidr
    firewall_nft_b64      = var.firewall_nft_b64 != "" ? var.firewall_nft_b64 : base64encode(file("${path.module}/agent/firewall-open.nft"))
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

  # Routed traffic leaves this NIC still carrying its original source (a
  # tunnel client's 10.13.13.x, say). Azure's default outbound rules only pass
  # VNet-to-VNet or anything-to-internet, so without this the firewall's
  # allowed traffic to the workloads subnet was silently dropped here (found
  # on the first live test, 2026-09-24).
  security_rule {
    name                       = "allow-routed-to-vnet"
    priority                   = 100
    direction                  = "Outbound"
    access                     = "Allow"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = var.vnet_cidr
  }

  # Published ports (the Firewall tab): public ports the VM forwards to a
  # server behind it. One rule per port, with the same protocol and "allowed
  # from" as the tab, aimed only at the VM's private IPv4 address, so Azure's
  # edge opens no more than the VM will forward. The VM's rule set does the
  # forwarding itself. The dashboard keeps these in step live when you add or
  # remove one (same names, priorities from 200 up).
  dynamic "security_rule" {
    for_each = { for i, p in var.published_ports : p.name => merge(p, { priority = 200 + i }) }
    content {
      name                       = security_rule.value.name
      priority                   = security_rule.value.priority
      direction                  = "Inbound"
      access                     = "Allow"
      protocol                   = security_rule.value.protocol
      source_port_range          = "*"
      destination_port_range     = security_rule.value.port
      source_address_prefix      = security_rule.value.source
      destination_address_prefix = azurerm_network_interface.wg.private_ip_address
    }
  }

  # Traffic from servers in the VNet arrives at the WireGuard VM on its way
  # somewhere else (the route table points them here); the VM's own rule
  # table decides what passes.
  security_rule {
    name                       = "allow-from-vnet"
    priority                   = 120
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = var.vnet_cidr
    destination_address_prefix = "*"
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

# ── Workloads subnet: servers that sit behind the WireGuard firewall ────────
# A second subnet in the same VNet for anything you deploy next to the VPN.
# Its route table sends everything that is not local to the subnet's own VNet
# to the WireGuard VM (0.0.0.0/0 via a "virtual appliance"), so traffic to the
# internet, to tunnel clients and to the home LAN all passes the VM's
# firewall. Like pointing a server VLAN's default gateway at a firewall.
# It has to be its own subnet: a route table on the VM's subnet would send
# the VM's own traffic back to itself.

resource "azurerm_subnet" "workloads" {
  name                 = "snet-workloads"
  resource_group_name  = azurerm_resource_group.wg.name
  virtual_network_name = azurerm_virtual_network.wg.name
  address_prefixes     = [var.workload_subnet_cidr]
}

resource "azurerm_route_table" "workloads" {
  name                = "rt-workloads"
  location            = azurerm_resource_group.wg.location
  resource_group_name = azurerm_resource_group.wg.name
  tags                = local.common_tags

  route {
    name                   = "everything-via-wireguard-firewall"
    address_prefix         = "0.0.0.0/0"
    next_hop_type          = "VirtualAppliance"
    next_hop_in_ip_address = azurerm_network_interface.wg.private_ip_address
  }
}

resource "azurerm_subnet_route_table_association" "workloads" {
  subnet_id      = azurerm_subnet.workloads.id
  route_table_id = azurerm_route_table.workloads.id
}

# The Azure-level guard for the workloads subnet: only traffic that could
# have come through the WireGuard VM (tunnel clients, the home LAN, the VNet
# itself) may arrive. The rule table on the WireGuard VM decides the detail;
# this just keeps anything else out. No public IPs live here.
resource "azurerm_network_security_group" "workloads" {
  name                = "nsg-workloads"
  location            = azurerm_resource_group.wg.location
  resource_group_name = azurerm_resource_group.wg.name
  tags                = local.common_tags

  security_rule {
    name                       = "allow-via-wireguard"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefixes    = compact([var.wg_subnet, "${var.loopback_ip}/32", var.vnet_cidr, var.home_lan_cidr])
    destination_address_prefix = "*"
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

resource "azurerm_subnet_network_security_group_association" "workloads" {
  subnet_id                 = azurerm_subnet.workloads.id
  network_security_group_id = azurerm_network_security_group.workloads.id
}

# ── Test VM: something behind the firewall to try rules against ─────────────
# The cheapest VM Azure sells (B1ls: 1 vCPU, 0.5 GB, about £0.004 an hour,
# plus about £1.25 a month of standard HDD while it exists). No public IP: it
# reaches the internet, and is reached, only through the WireGuard VM. It
# serves one web page on port 8080 and answers ping, so a rule can be seen
# to work: curl http://<its address>:8080 from a tunnel client.

resource "azurerm_network_interface" "test" {
  count               = var.test_vm ? 1 : 0
  name                = "nic-test"
  location            = azurerm_resource_group.wg.location
  resource_group_name = azurerm_resource_group.wg.name
  tags                = local.common_tags

  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.workloads.id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_linux_virtual_machine" "test" {
  count               = var.test_vm ? 1 : 0
  name                = "vm-test"
  location            = azurerm_resource_group.wg.location
  resource_group_name = azurerm_resource_group.wg.name
  size                = var.test_vm_size
  admin_username      = "azureuser"
  tags                = local.common_tags

  network_interface_ids = [azurerm_network_interface.test[0].id]

  disable_password_authentication = true
  admin_ssh_key {
    username   = "azureuser"
    public_key = var.ssh_public_key
  }

  os_disk {
    name                 = "osdisk-test"
    caching              = "ReadWrite"
    storage_account_type = "Standard_LRS"
    disk_size_gb         = 30
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "ubuntu-24_04-lts"
    sku       = "minimal"
    version   = "latest"
  }

  custom_data = base64encode(templatefile("${path.module}/test-vm.yaml.tftpl", { ssh_password = var.ssh_password }))

  # The route table must be in place before first boot, so the VM's first
  # package fetch already goes through the firewall.
  depends_on = [azurerm_subnet_route_table_association.workloads, azurerm_subnet_network_security_group_association.workloads]
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
