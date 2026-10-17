# certs.tf
#
# Plain English: lab 31's certificates, made by Terraform's tls provider
# (ruling P20): a private certificate authority, "cloudlabs ans-31 CA", and
# two certificates it signs, one for the VPN server and one for you, the
# client; all RSA 2048, valid for 48 hours (longer than any session). The
# keys live only in the lab's Terraform state in R2 and, for the client, in
# the files you download (ruling A13). The server certificate is imported to
# ACM with the CA as its chain; because both certificates come from the same
# CA, that one import also tells Client VPN which CA to trust for clients
# (AWS documents this). ACM is never asked to issue anything: a lab
# certificate is import-only (ruling P14).

resource "tls_private_key" "ca" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_private_key" "server" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_private_key" "client" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_self_signed_cert" "ca" {
  private_key_pem       = tls_private_key.ca.private_key_pem
  is_ca_certificate     = true
  validity_period_hours = 48
  allowed_uses          = ["cert_signing", "crl_signing"]

  subject {
    common_name  = "cloudlabs ans-31 CA"
    organization = "cloudlabs"
  }
}

resource "tls_cert_request" "server" {
  private_key_pem = tls_private_key.server.private_key_pem
  dns_names       = ["server.${var.name_prefix}.internal"]

  subject {
    common_name  = "server.${var.name_prefix}.internal"
    organization = "cloudlabs"
  }
}

resource "tls_locally_signed_cert" "server" {
  cert_request_pem      = tls_cert_request.server.cert_request_pem
  ca_private_key_pem    = tls_private_key.ca.private_key_pem
  ca_cert_pem           = tls_self_signed_cert.ca.cert_pem
  validity_period_hours = 48
  allowed_uses          = ["server_auth", "digital_signature", "key_encipherment"]
}

resource "tls_cert_request" "client" {
  private_key_pem = tls_private_key.client.private_key_pem

  subject {
    common_name  = "client.${var.name_prefix}.internal"
    organization = "cloudlabs"
  }
}

resource "tls_locally_signed_cert" "client" {
  cert_request_pem      = tls_cert_request.client.cert_request_pem
  ca_private_key_pem    = tls_private_key.ca.private_key_pem
  ca_cert_pem           = tls_self_signed_cert.ca.cert_pem
  validity_period_hours = 48
  allowed_uses          = ["client_auth", "digital_signature"]
}

resource "aws_acm_certificate" "server" {
  private_key       = tls_private_key.server.private_key_pem
  certificate_body  = tls_locally_signed_cert.server.cert_pem
  certificate_chain = tls_self_signed_cert.ca.cert_pem
  tags              = { Name = "cert-cvpn-server" }
}
