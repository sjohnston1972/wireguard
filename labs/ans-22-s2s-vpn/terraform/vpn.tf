# vpn.tf
#
# Plain English: lab 22's AWS side of the VPN (ruling P11). The virtual
# private gateway vgw-lab, attached to vpc-lab on Amazon's ASN 64512, puts
# the routes it learns by BGP into rt-private. The customer gateway
# cgw-onprem is the router's Elastic IP on ASN 65001. The VPN connection
# vpn-lab has two IPsec tunnels (IKEv2), each with a 32-letter pre-shared
# key made here (they reach the router only in its user data; ruling A12's
# reasoning), and dynamic (BGP) routing. AWS picks each tunnel's /30 inside
# range from 169.254.0.0/16 (a literal range would break the lint's
# literal-cidr rule); the router reads the chosen addresses from this
# connection. Tunnel logs stay off (ruling P8); acceleration, private
# outside addresses and a transit gateway end are never (rule never).

resource "aws_vpn_gateway" "lab" {
  vpc_id          = aws_vpc.lab.id
  amazon_side_asn = 64512
  tags            = { Name = "vgw-lab" }
}

resource "aws_vpn_gateway_route_propagation" "private" {
  vpn_gateway_id = aws_vpn_gateway.lab.id
  route_table_id = aws_route_table.private.id
}

resource "aws_customer_gateway" "onprem" {
  bgp_asn    = 65001
  ip_address = aws_eip.router.public_ip
  type       = "ipsec.1"
  tags       = { Name = "cgw-onprem" }
}

# Letters only: AWS refuses a key that starts with 0, and the router's config needs no quoting.
resource "random_password" "psk1" {
  length  = 32
  special = false
  numeric = false
}

resource "random_password" "psk2" {
  length  = 32
  special = false
  numeric = false
}

resource "aws_vpn_connection" "lab" {
  vpn_gateway_id        = aws_vpn_gateway.lab.id
  customer_gateway_id   = aws_customer_gateway.onprem.id
  type                  = "ipsec.1"
  static_routes_only    = false
  tunnel1_preshared_key = random_password.psk1.result
  tunnel2_preshared_key = random_password.psk2.result
  tunnel1_ike_versions  = ["ikev2"]
  tunnel2_ike_versions  = ["ikev2"]
  tags                  = { Name = "vpn-lab" }
}
