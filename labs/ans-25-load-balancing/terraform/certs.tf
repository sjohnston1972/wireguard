# certs.tf
#
# Plain English: lab 25's certificate, made in the lab's own state and
# imported to ACM (ruling P14: import only, never requested from a CA). A
# self-signed CA, "cloudlabs ans-25 CA", signs a server certificate for
# app.<name_prefix>.internal (RSA 2048, both valid a week). The ALB's HTTPS
# listener and the NLB's TLS listener both use the one imported certificate.
# Browsers and curl do not trust it, which is the point: curl -k, or read the
# chain with openssl. The keys live only in the lab's R2 state.

resource "tls_private_key" "ca" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_private_key" "server" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_self_signed_cert" "ca" {
  private_key_pem       = tls_private_key.ca.private_key_pem
  is_ca_certificate     = true
  validity_period_hours = 168
  allowed_uses          = ["cert_signing", "crl_signing"]

  subject {
    common_name  = "cloudlabs ans-25 CA"
    organization = "cloudlabs"
  }
}

resource "tls_cert_request" "server" {
  private_key_pem = tls_private_key.server.private_key_pem
  dns_names       = ["app.${var.name_prefix}.internal"]

  subject {
    common_name  = "app.${var.name_prefix}.internal"
    organization = "cloudlabs"
  }
}

resource "tls_locally_signed_cert" "server" {
  cert_request_pem      = tls_cert_request.server.cert_request_pem
  ca_private_key_pem    = tls_private_key.ca.private_key_pem
  ca_cert_pem           = tls_self_signed_cert.ca.cert_pem
  validity_period_hours = 168
  allowed_uses          = ["server_auth", "digital_signature", "key_encipherment"]
}

resource "aws_acm_certificate" "app" {
  private_key       = tls_private_key.server.private_key_pem
  certificate_body  = tls_locally_signed_cert.server.cert_pem
  certificate_chain = tls_self_signed_cert.ca.cert_pem
  tags              = { Name = "cert-app" }
}
