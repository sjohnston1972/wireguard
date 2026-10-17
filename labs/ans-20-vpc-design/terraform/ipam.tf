# ipam.tf
#
# Plain English: lab 20's IP Address Manager, on the Free Tier (ruling P5).
# One IPAM operating only in the session's region and, in its public scope,
# one pool, pool-v6: IPv6 space Amazon provides (never addresses the lab
# brings), advertisable for EC2 and VPCs in London. A /52 is provisioned to
# the pool (room for sixteen /56 VPC ranges) and vpc-lab takes one /56 from
# it (ruling A82: the association is judged on the lab's own tagged pool).
# Private IPv4 pools need the paid Advanced Tier, so the lab's second IPv4
# range (dual.tf) comes straight from the slot. cascade = true: deleting the
# IPAM takes its scopes and pools with it.

resource "aws_vpc_ipam" "lab" {
  description = "lab ${var.lab_id}: Free Tier IPAM in the session region"
  tier        = "free"
  cascade     = true

  operating_regions {
    region_name = var.region
  }
  tags = { Name = "ipam-lab" }
}

resource "aws_vpc_ipam_pool" "v6" {
  description      = "lab ${var.lab_id}: Amazon-provided IPv6 for VPCs in the session region"
  address_family   = "ipv6"
  ipam_scope_id    = aws_vpc_ipam.lab.public_default_scope_id
  locale           = var.region
  public_ip_source = "amazon"
  aws_service      = "ec2"
  tags             = { Name = "pool-v6" }
}

# Amazon-provided space: a netmask length only, never a literal range (BYOIP is never, ruling P5).
resource "aws_vpc_ipam_pool_cidr" "v6" {
  ipam_pool_id   = aws_vpc_ipam_pool.v6.id
  netmask_length = 52
}

resource "aws_vpc_ipv6_cidr_block_association" "lab" {
  vpc_id              = aws_vpc.lab.id
  ipv6_ipam_pool_id   = aws_vpc_ipam_pool.v6.id
  ipv6_netmask_length = 56
  depends_on          = [aws_vpc_ipam_pool_cidr.v6]
}
