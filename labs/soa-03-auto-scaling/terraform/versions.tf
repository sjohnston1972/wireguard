# versions.tf
#
# Plain English: the providers an AWS lab uses (AWS labs spec §4): Terraform
# 1.14.6 in the workflow, hashicorp/aws 6.x, and only as a lab needs them
# random, time, tls and archive. Every allowed provider is pinned here, so a
# lab that uses time or archive resolves the same versions as the fixtures
# (ruling P2). Credentials come from the run's per-step STS
# session in the environment, never from here: the provider block holds the
# region and the lab's tags only. The state lives in R2 at
# labs/<id>/terraform.tfstate; lab-aws.yml passes the bucket, keys and key
# at init from a file, so nothing secret or lab-specific is written here.

terraform {
  required_version = ">= 1.14.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.13"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }

  backend "s3" {
    region       = "auto"
    use_lockfile = true

    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = var.tags
  }
}
