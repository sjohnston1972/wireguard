# consumer.tf
#
# Plain English: lab 24's consumer side, in the template's vpc-lab. An
# interface endpoint, vpce-svc, to the lab's own endpoint service (ruling
# P13), in snet-private-1 only (one Availability Zone, one hourly charge),
# admitting HTTP from vpc-lab. Its "private DNS" is a private hosted zone,
# svc.<name_prefix>.internal (ruling A88), with app as an alias of the
# endpoint's own name. And S3 through the template's gateway endpoint, now
# with a policy (ruling A100): through it only the lab's bucket,
# cloudlabs-<name_prefix>-data (one object, hello.txt), and Amazon Linux's
# package repositories can be reached.

locals {
  data_bucket = "cloudlabs-${var.name_prefix}-data"
  data_arn    = "arn:aws:s3:::cloudlabs-${var.name_prefix}-data"
  svc_domain  = "svc.${var.name_prefix}.internal"
}

resource "aws_security_group" "endpoint" {
  name        = "lab-endpoint"
  description = "The interface endpoint: HTTP from vpc-lab"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "sg-endpoint" }
}

resource "aws_vpc_security_group_ingress_rule" "endpoint_http" {
  security_group_id = aws_security_group.endpoint.id
  cidr_ipv4         = local.vpc_cidr
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_endpoint" "svc" {
  vpc_id              = aws_vpc.lab.id
  service_name        = aws_vpc_endpoint_service.lab.service_name
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [aws_subnet.private[0].id]
  security_group_ids  = [aws_security_group.endpoint.id]
  private_dns_enabled = false
  tags                = { Name = "vpce-svc" }
}

resource "aws_route53_zone" "svc" {
  name          = local.svc_domain
  force_destroy = true

  vpc {
    vpc_id     = aws_vpc.lab.id
    vpc_region = var.region
  }
  tags = { Name = "zone-svc" }
}

resource "aws_route53_record" "app" {
  zone_id = aws_route53_zone.svc.zone_id
  name    = "app.${local.svc_domain}"
  type    = "A"

  alias {
    name                   = aws_vpc_endpoint.svc.dns_entry[0].dns_name
    zone_id                = aws_vpc_endpoint.svc.dns_entry[0].hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_vpc_endpoint_policy" "s3" {
  vpc_endpoint_id = aws_vpc_endpoint.s3.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "LabBucketOnly", Effect = "Allow", Principal = "*", Action = "s3:*", Resource = [local.data_arn, "${local.data_arn}/*"] },
      { Sid = "AmazonLinuxRepositories", Effect = "Allow", Principal = "*", Action = "s3:GetObject", Resource = "arn:aws:s3:::al2023-repos-${var.region}-*/*" },
    ]
  })
}

resource "aws_s3_bucket" "data" {
  bucket        = local.data_bucket
  force_destroy = true
  tags          = { Name = "data" }
}

resource "aws_s3_bucket_public_access_block" "data" {
  bucket                  = aws_s3_bucket.data.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_object" "hello" {
  bucket       = aws_s3_bucket.data.id
  key          = "hello.txt"
  content      = "read through the S3 gateway endpoint, whose policy allows only this bucket\n"
  content_type = "text/plain"
}
