# router.tf
#
# Plain English: lab 22's "on-prem" router, vm-router (ruling P11): Ubuntu
# Server 24.04 arm64 on a t4g.micro (strongSwan and FRR come from Ubuntu's
# archive; Amazon Linux has no FRR), at a fixed address in snet-onprem,
# with source/destination checking off because it forwards for its
# network, and the lab's one public instance address, the Elastic IP
# eip-router (spec §7.4). Its security group admits IKE and IPsec (UDP 500
# and 4500) only from the two tunnel outside addresses of the lab's own VPN
# connection, and SSH only from eice-onprem; never anything else from the
# internet. At boot it makes one route-based (VTI) interface per tunnel,
# installs strongSwan and FRR (retrying until the Elastic IP is attached
# and the archive answers), brings both tunnels up from its side and peers
# by BGP with the two AWS inside addresses, advertising vpc-onprem's /20.
# labadmin is in group sudo (Ubuntu has no wheel).

data "aws_ssm_parameter" "ubuntu_arm64" {
  name = "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id"
}

locals {
  tunnels = [
    { n = 1, outside = aws_vpn_connection.lab.tunnel1_address, cgw = aws_vpn_connection.lab.tunnel1_cgw_inside_address, vgw = aws_vpn_connection.lab.tunnel1_vgw_inside_address, psk = random_password.psk1.result },
    { n = 2, outside = aws_vpn_connection.lab.tunnel2_address, cgw = aws_vpn_connection.lab.tunnel2_cgw_inside_address, vgw = aws_vpn_connection.lab.tunnel2_vgw_inside_address, psk = random_password.psk2.result },
  ]

  # One VTI per tunnel, keyed (marked) as its swanctl child is; AWS's inside ranges are /30s.
  router_vti = <<-EOT
    #!/bin/sh
    # Lab 22: the two route-based tunnel interfaces (made again at every boot).
    %{for t in local.tunnels~}
    ip link del vti${t.n} 2>/dev/null || true
    ip tunnel add vti${t.n} local ${local.router_ip} remote ${t.outside} mode vti key ${t.n * 100}
    ip addr add ${t.cgw}/30 dev vti${t.n}
    ip link set vti${t.n} up mtu 1419
    sysctl -w net.ipv4.conf.vti${t.n}.disable_policy=1
    %{endfor~}
  EOT

  router_vti_unit = join("\n", [
    "[Unit]",
    "Description=Lab 22 VTI interfaces for the two AWS tunnels",
    "Wants=network-online.target",
    "After=network-online.target",
    "Before=strongswan.service frr.service",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    "ExecStart=/usr/local/sbin/lab-vti",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ])

  # IKEv2 from the router's side, behind its Elastic IP (NAT traversal on UDP 4500); the IKE identity is the Elastic IP.
  router_swanctl = <<-EOT
    connections {
    %{for t in local.tunnels~}
      aws${t.n} {
        version = 2
        local_addrs = ${local.router_ip}
        remote_addrs = ${t.outside}
        proposals = aes256-sha256-modp2048
        dpd_delay = 10s
        local {
          auth = psk
          id = ${aws_eip.router.public_ip}
        }
        remote {
          auth = psk
          id = ${t.outside}
        }
        children {
          aws${t.n} {
            local_ts = 0.0.0.0/0
            remote_ts = 0.0.0.0/0
            mark_in = ${t.n * 100}
            mark_out = ${t.n * 100}
            esp_proposals = aes256-sha256-modp2048
            start_action = start
            dpd_action = restart
          }
        }
      }
    %{endfor~}
    }
    secrets {
    %{for t in local.tunnels~}
      ike-aws${t.n} {
        id-local = ${aws_eip.router.public_ip}
        id-remote = ${t.outside}
        secret = ${t.psk}
      }
    %{endfor~}
    }
  EOT

  # BGP: ASN 65001 to the virtual private gateway's 64512 over each tunnel, advertising the whole on-prem /20.
  router_frr = <<-EOT
    frr defaults traditional
    hostname vm-router
    log syslog informational
    !
    router bgp ${aws_customer_gateway.onprem.bgp_asn}
     bgp router-id ${local.router_ip}
     no bgp ebgp-requires-policy
     no bgp network import-check
    %{for t in local.tunnels~}
     neighbor ${t.vgw} remote-as ${aws_vpn_gateway.lab.amazon_side_asn}
     neighbor ${t.vgw} timers 10 30
    %{endfor~}
     !
     address-family ipv4 unicast
      network ${local.onprem_cidr}
     exit-address-family
    !
  EOT

  router_cloud_init = "#cloud-config\n${yamlencode(merge(local.cloud_init_base, {
    users = [
      "default",
      { name = "labadmin", groups = ["sudo"], sudo = "ALL=(ALL) NOPASSWD:ALL", shell = "/bin/bash", lock_passwd = false },
    ]
    # Ubuntu 24.04 flags the template's chpasswd.list as deprecated; this is the modern form.
    chpasswd = { expire = false, users = [{ name = "labadmin", password = var.admin_password, type = "text" }] }
    write_files = [
      { path = "/etc/sysctl.d/90-lab-router.conf", permissions = "0644", content = "net.ipv4.ip_forward = 1\n" },
      { path = "/usr/local/sbin/lab-vti", permissions = "0755", content = local.router_vti },
      { path = "/etc/systemd/system/lab-vti.service", permissions = "0644", content = local.router_vti_unit },
      { path = "/etc/swanctl/conf.d/aws.conf", permissions = "0600", content = local.router_swanctl },
      { path = "/etc/strongswan.d/charon-lab.conf", permissions = "0644", content = "charon {\n  install_routes = no\n}\n" },
      { path = "/usr/local/share/lab/frr.conf", permissions = "0644", content = local.router_frr },
    ]
    runcmd = [
      "sysctl --system",
      "systemctl daemon-reload",
      "systemctl enable --now lab-vti.service",
      "for i in $(seq 1 30); do DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y -o Dpkg::Options::=--force-confold strongswan-swanctl charon-systemd frr && break; sleep 10; done",
      "install -m 0640 -o frr -g frr /usr/local/share/lab/frr.conf /etc/frr/frr.conf",
      "sed -i 's/^bgpd=no/bgpd=yes/' /etc/frr/daemons",
      "systemctl restart frr",
      "systemctl enable strongswan",
      "systemctl restart strongswan",
      "swanctl --load-all",
    ]
  }))}"
}

resource "aws_eip" "router" {
  domain = "vpc"
  tags   = { Name = "eip-router" }
}

resource "aws_eip_association" "router" {
  instance_id   = aws_instance.router.id
  allocation_id = aws_eip.router.id
}

resource "aws_security_group" "router" {
  name        = "lab-router"
  description = "vm-router: IKE and IPsec from the two AWS tunnel endpoints, SSH from eice-onprem"
  vpc_id      = aws_vpc.onprem.id
  tags        = { Name = "sg-router" }
}

resource "aws_vpc_security_group_ingress_rule" "router_ike_1" {
  security_group_id = aws_security_group.router.id
  cidr_ipv4         = "${aws_vpn_connection.lab.tunnel1_address}/32"
  ip_protocol       = "udp"
  from_port         = 500
  to_port           = 500
}

resource "aws_vpc_security_group_ingress_rule" "router_ike_2" {
  security_group_id = aws_security_group.router.id
  cidr_ipv4         = "${aws_vpn_connection.lab.tunnel2_address}/32"
  ip_protocol       = "udp"
  from_port         = 500
  to_port           = 500
}

resource "aws_vpc_security_group_ingress_rule" "router_natt_1" {
  security_group_id = aws_security_group.router.id
  cidr_ipv4         = "${aws_vpn_connection.lab.tunnel1_address}/32"
  ip_protocol       = "udp"
  from_port         = 4500
  to_port           = 4500
}

resource "aws_vpc_security_group_ingress_rule" "router_natt_2" {
  security_group_id = aws_security_group.router.id
  cidr_ipv4         = "${aws_vpn_connection.lab.tunnel2_address}/32"
  ip_protocol       = "udp"
  from_port         = 4500
  to_port           = 4500
}

resource "aws_vpc_security_group_ingress_rule" "router_ssh_eice" {
  security_group_id            = aws_security_group.router.id
  referenced_security_group_id = aws_security_group.eice_onprem.id
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
}

resource "aws_vpc_security_group_egress_rule" "router_all" {
  security_group_id = aws_security_group.router.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "router" {
  ami                    = data.aws_ssm_parameter.ubuntu_arm64.insecure_value
  instance_type          = "t4g.micro"
  subnet_id              = aws_subnet.onprem.id
  private_ip             = local.router_ip
  source_dest_check      = false
  vpc_security_group_ids = [aws_security_group.router.id]
  user_data              = local.router_cloud_init

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    delete_on_termination = true
  }
  volume_tags = merge(var.tags, { Name = "vm-router" })
  tags        = { Name = "vm-router" }
  depends_on  = [aws_route.onprem_internet, aws_route_table_association.onprem, aws_vpc_endpoint.onprem_s3]
}
