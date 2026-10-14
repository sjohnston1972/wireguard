# providers.tf (AWS)
#
# Plain English: the drivers for AWS and Cloudflare, pinned. Credentials are
# not here: in GitHub Actions the AWS provider assumes the wg-admin-deploy role
# with the run's own signed identity (AWS_ROLE_ARN + AWS_WEB_IDENTITY_TOKEN_FILE),
# and Cloudflare reads the narrow DNS token from CLOUDFLARE_API_TOKEN.

terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      "wg-admin" = "vpn"
      project    = "wg-admin"
      run_id     = var.run_id
      managed    = "terraform"
    }
  }
}

provider "cloudflare" {}
