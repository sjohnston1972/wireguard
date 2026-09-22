# backend.tf
#
# Plain English: Terraform keeps a "state file", its own inventory of what it
# built and the IDs Azure gave each piece. It is the equivalent of a router's
# startup-config: lose it and the box still runs, but you no longer know what
# you have. We keep it in a Cloudflare R2 bucket, which speaks the same
# protocol as Amazon S3, so Terraform's built-in S3 backend works unchanged.
#
# Locking: Terraform 1.10+ can lock the state with a small ".tflock" object in
# the same bucket (use_lockfile). R2 supports the conditional write that needs,
# so two runs can never write state at the same time.
#
# Nothing secret lives here. The workflow supplies at init time:
#   -backend-config="bucket=<R2_BUCKET>"
# and the environment carries AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and
# AWS_ENDPOINT_URL_S3 (https://<account id>.r2.cloudflarestorage.com).

terraform {
  backend "s3" {
    key          = "wg-admin/terraform.tfstate"
    region       = "auto"
    use_lockfile = true

    # R2 is not AWS. These flags stop the backend from trying AWS-only checks.
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}
