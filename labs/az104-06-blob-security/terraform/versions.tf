# versions.tf
#
# Plain English: the providers this lab uses, pinned as labs/_template pins
# them (Terraform 1.14.6 in the workflow, azurerm 4.x, azuread 3.x for the
# readers group). Credentials come from ARM_* in the environment; the state
# lives in R2 at labs/<id>/terraform.tfstate, and the workflow passes the
# bucket and key at init time.

terraform {
  required_version = ">= 1.14.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 3.0"
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

    storage {
      # Terraform talks to the storage account only through Azure Resource
      # Manager, never its blob endpoint. The lab invites you to turn public
      # network access off; tear-down from the GitHub runner still works.
      data_plane_available = false
    }
  }
}
