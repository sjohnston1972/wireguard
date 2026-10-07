# versions.tf
#
# Plain English: the providers this lab uses, pinned as labs/_template pins
# them (Terraform 1.14.6 in the workflow, azurerm 4.x). This lab makes no
# Entra objects, so it needs no azuread. Credentials come from ARM_* in the
# environment; the state lives in R2 at labs/<id>/terraform.tfstate, and the
# workflow passes the bucket and key at init time.

terraform {
  required_version = ">= 1.14.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
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

provider "azurerm" {
  features {
    resource_group {
      # Tear-down must always reach £0, even with something left inside
      # (a queue, topic or container you made by hand).
      prevent_deletion_if_contains_resources = false
    }

    log_analytics_workspace {
      # Deleted for good, not soft-deleted for 14 days: a soft-deleted
      # workspace of the same name would be recovered by the next deploy,
      # with the last session's logs and settings.
      permanently_delete_on_destroy = true
    }

    storage {
      # The containers are made through Resource Manager, and the provider
      # never reads the account's blob or queue endpoints with its key, so
      # tear-down works whatever is done to the account by hand.
      data_plane_available = false
    }
  }
}
