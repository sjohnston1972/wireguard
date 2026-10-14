# backend.tf
#
# Plain English: the bootstrap's own state, in the same R2 bucket as the
# headend's, under its own key. Credentials come from a -backend-config file
# written by scripts/aws-bootstrap.mjs, never from AWS_* variables (those are
# the admin keys, for the AWS provider only).

terraform {
  backend "s3" {
    key                         = "wg-admin/aws-bootstrap/terraform.tfstate"
    region                      = "auto"
    use_lockfile                = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}
