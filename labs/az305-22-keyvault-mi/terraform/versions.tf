# versions.tf
#
# Plain English: the providers this lab uses, pinned as labs/_template pins
# azurerm (Terraform 1.14.6 in the workflow, azurerm 4.x), plus random for
# the secrets' values and time for the wait while the pipeline's vault role
# propagates (the template pins neither, so they are declared here). This lab
# makes no Entra objects, so it needs no azuread. Credentials come from ARM_*
# in the environment; the state lives in R2 at labs/<id>/terraform.tfstate,
# and the workflow passes the bucket and key at init time.

terraform {
  required_version = ">= 1.14.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.13"
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

provider "azurerm" {
  features {
    resource_group {
      # Tear-down must always reach £0, even with something left inside.
      prevent_deletion_if_contains_resources = false
    }

    key_vault {
      # Spec §17 ruling 30: the vault is purged on destroy, never left
      # soft-deleted, and a deploy never brings back an old one. Secrets are
      # only soft-deleted on destroy, not purged one by one: they go when
      # the vault is purged.
      purge_soft_delete_on_destroy          = true
      purge_soft_deleted_secrets_on_destroy = false
      recover_soft_deleted_key_vaults       = false
    }
  }
}
