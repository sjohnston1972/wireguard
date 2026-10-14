# main.tf (AWS)
#
# Plain English: the same headend as infra/main.tf, built in AWS London.
#   VPC 10.50.0.0/16 (the same plan as Azure's VNet, so client configs never change)
#     snet-wg 10.50.1.0/24        the WireGuard server, Elastic IP, IPv6
#     snet-workloads 10.50.2.0/24 servers behind it; default route = the server
#   Security group wg-admin-headend (Name tag sg-wg; AWS forbids group names
#   starting "sg-"): WireGuard UDP, SSH from home, published ports, the VPC.
# The server's network card (nic-wg) and Elastic IP are made before the
# instance, so it boots with a public address. The card routes between tunnel,
# VPC and internet, so its source/destination check is off (AWS drops
# forwarded packets otherwise).
# Everything carries wg-admin=vpn (provider default_tags) so the workflow's
# safety net and the Worker can find it all.

locals {
  # ── Copied from infra/main.tf (scripts/test/tf-twins.test.mjs keeps them identical) ──
  # Only peers with a proper WireGuard key and a plain IPv4 address get into
  # wg0.conf (the dashboard checks the same; this is the second lock).
  peers = [
    for p in jsondecode(var.peers_json) : p
    if can(regex("^[A-Za-z0-9+/]{43}=$", p.public_key)) && can(regex("^[0-9]{1,3}(\\.[0-9]{1,3}){3}$", p.ip))
  ]
  wg_server_ip  = cidrhost(var.wg_subnet, 1)
  wg_prefix_len = split("/", var.wg_subnet)[1]
  ipv6          = var.wg_subnet6 != ""
  # IPv6 inside the tunnel mirrors IPv4: 10.13.13.7 is fd13:13::7. The
  # dashboard derives the same address, so the two always agree.
  wg_server_ip6 = local.ipv6 ? cidrhost(var.wg_subnet6, 1) : ""
  peer_ip6      = { for p in local.peers : p.ip => local.ipv6 ? cidrhost(var.wg_subnet6, tonumber(split(".", p.ip)[3])) : "" }

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
  arm = can(regex("^[a-z]+[0-9]+g[a-z]*\\.", var.vm_size))

  # The server's boot script. Same template as Azure; the agent files arrive
  # in the boot bundle (AWS allows 16 KB of user data), so they are empty here.
  cloud_init = templatefile("${path.module}/../cloud-init.yaml.tftpl", {
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
    agent_script_gz       = base64gzip("")
    agent_service         = file("${path.module}/../agent/wg-agent.service")
    agent_timer           = file("${path.module}/../agent/wg-agent.timer")
    selftest_script       = ""
    selftest_service      = file("${path.module}/../agent/wg-selftest.service")
    blocklist_script      = ""
    blocklist_service     = file("${path.module}/../agent/wg-blocklist.service")
    speedtest_script      = ""
    capture_script        = ""
    firewall_load_script  = ""
    vnet_cidr             = var.vnet_cidr
    firewall_nft_gz       = base64gzip("")
    vitals_script_gz      = base64gzip("")
    admin_user            = "ubuntu"
    wan_if                = "ens5"
    azure_only            = ""
    cloud                 = "aws"
    boot_bundle_sha256    = var.boot_bundle_sha256
  })
}

data "aws_availability_zones" "up" {
  state = "available"
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-${local.arm ? "arm64" : "amd64"}-server-*"]
  }
}

resource "aws_vpc" "wg" {
  cidr_block                       = var.vnet_cidr
  assign_generated_ipv6_cidr_block = local.ipv6
  enable_dns_support               = true
  enable_dns_hostnames             = true
  tags                             = { Name = "vpc-wg" }
}

resource "aws_internet_gateway" "wg" {
  vpc_id = aws_vpc.wg.id
  tags   = { Name = "igw-wg" }
}

resource "aws_subnet" "wg" {
  vpc_id                          = aws_vpc.wg.id
  cidr_block                      = var.subnet_cidr
  availability_zone               = data.aws_availability_zones.up.names[0]
  ipv6_cidr_block                 = local.ipv6 ? cidrsubnet(aws_vpc.wg.ipv6_cidr_block, 8, 1) : null
  assign_ipv6_address_on_creation = local.ipv6
  tags                            = { Name = "snet-wg" }
}

resource "aws_route_table" "wg" {
  vpc_id = aws_vpc.wg.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.wg.id
  }
  dynamic "route" {
    for_each = local.ipv6 ? [1] : []
    content {
      ipv6_cidr_block = "::/0"
      gateway_id      = aws_internet_gateway.wg.id
    }
  }
  tags = { Name = "rt-wg" }
}

resource "aws_route_table_association" "wg" {
  subnet_id      = aws_subnet.wg.id
  route_table_id = aws_route_table.wg.id
}

resource "aws_key_pair" "wg" {
  key_name   = "wg-admin-${var.run_id}"
  public_key = var.ssh_public_key
}

resource "aws_security_group" "wg" {
  name        = "wg-admin-headend"
  description = "wg-admin headend"
  vpc_id      = aws_vpc.wg.id
  tags        = { Name = "sg-wg", "wg-admin-role" = "headend" }

  ingress {
    description      = "wireguard"
    protocol         = "udp"
    from_port        = var.wg_port
    to_port          = var.wg_port
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  # The Worker edits this rule live (SSH from here); same name.
  dynamic "ingress" {
    for_each = var.ssh_allowed_cidr != "" ? [var.ssh_allowed_cidr] : []
    content {
      description = "ssh-from-home"
      protocol    = "tcp"
      from_port   = 22
      to_port     = 22
      cidr_blocks = [ingress.value]
    }
  }

  # Published ports; the Worker keeps these in step with the Firewall tab.
  dynamic "ingress" {
    for_each = var.published_ports
    content {
      description = ingress.value.name
      protocol    = lower(ingress.value.protocol)
      from_port   = tonumber(ingress.value.port)
      to_port     = tonumber(ingress.value.port)
      cidr_blocks = [ingress.value.source == "*" ? "0.0.0.0/0" : ingress.value.source]
    }
  }

  ingress {
    description = "from-vpc"
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = [var.vnet_cidr]
  }

  egress {
    protocol         = "-1"
    from_port        = 0
    to_port          = 0
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }
}

# The server's network card, made first so the Elastic IP is on it before the
# instance boots (cloud-init's apt step needs IPv4 internet straight away).
resource "aws_network_interface" "wg" {
  subnet_id          = aws_subnet.wg.id
  security_groups    = [aws_security_group.wg.id]
  source_dest_check  = false
  ipv6_address_count = local.ipv6 ? 1 : 0
  tags               = { Name = "nic-wg" }
}

resource "aws_eip" "wg" {
  domain            = "vpc"
  network_interface = aws_network_interface.wg.id
  tags              = { Name = "pip-wg" }
  depends_on        = [aws_internet_gateway.wg]
}

resource "aws_instance" "wg" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.vm_size
  key_name                    = aws_key_pair.wg.key_name
  user_data_base64            = base64gzip(local.cloud_init)
  user_data_replace_on_change = true
  # Forwarding (source/destination check off) is set on the ENI it launches on
  # (aws_network_interface.wg); the provider refuses source_dest_check here
  # alongside a network_interface block.

  network_interface {
    network_interface_id = aws_network_interface.wg.id
    device_index         = 0
  }

  # The public IP and the default route must exist before the first boot.
  depends_on = [aws_eip.wg, aws_route_table_association.wg]

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 8
    encrypted             = true
    delete_on_termination = true
  }

  # default_tags do not reach the root volume. volume_tags go in with the launch
  # itself (RunInstances), which the deploy role allows; a later CreateTags is denied.
  volume_tags = { "wg-admin" = "vpn", project = "wg-admin", run_id = var.run_id, Name = "osdisk-wg" }

  tags = { Name = "vm-wg", "wg-admin-role" = "headend" }

  lifecycle {
    ignore_changes = [ami]
  }
}

# ── Workloads: servers behind the WireGuard firewall ─────────────────────────
resource "aws_subnet" "workloads" {
  vpc_id            = aws_vpc.wg.id
  cidr_block        = var.workload_subnet_cidr
  availability_zone = data.aws_availability_zones.up.names[0]
  tags              = { Name = "snet-workloads" }
}

resource "aws_route_table" "workloads" {
  vpc_id = aws_vpc.wg.id
  route {
    cidr_block           = "0.0.0.0/0"
    network_interface_id = aws_network_interface.wg.id
  }
  tags = { Name = "rt-workloads" }
}

resource "aws_route_table_association" "workloads" {
  subnet_id      = aws_subnet.workloads.id
  route_table_id = aws_route_table.workloads.id
}

resource "aws_security_group" "workloads" {
  name        = "wg-admin-workloads"
  description = "wg-admin workloads: reachable from the tunnel, the VPC and home only"
  vpc_id      = aws_vpc.wg.id
  tags        = { Name = "sg-workloads" }

  ingress {
    description = "tunnel-vpc-home"
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = compact([var.wg_subnet, "${var.loopback_ip}/32", var.vnet_cidr, var.home_lan_cidr])
  }

  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "test" {
  count                  = var.test_vm ? 1 : 0
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.test_vm_size
  subnet_id              = aws_subnet.workloads.id
  vpc_security_group_ids = [aws_security_group.workloads.id]
  key_name               = aws_key_pair.wg.key_name
  user_data              = templatefile("${path.module}/../test-vm.yaml.tftpl", { ssh_password = var.ssh_password, admin_user = "ubuntu" })

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 8
    encrypted             = true
    delete_on_termination = true
  }

  # Same reason as the headend: tagged at launch, not by a later CreateTags.
  volume_tags = { "wg-admin" = "vpn", project = "wg-admin", run_id = var.run_id, Name = "osdisk-test" }

  tags       = { Name = "vm-test" }
  depends_on = [aws_route_table_association.workloads]

  lifecycle {
    ignore_changes = [ami]
  }
}

resource "cloudflare_dns_record" "wg" {
  zone_id = var.cloudflare_zone_id
  name    = var.wg_dns_name
  type    = "A"
  content = aws_eip.wg.public_ip
  ttl     = 60
  proxied = false
  comment = "Managed by wg-admin Terraform. Do not edit by hand."
}
