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
      # Tear-down must always reach £0, even with something left inside.
      prevent_deletion_if_contains_resources = false
    }

    recovery_service {
      # Destroying the protected VM stops protection AND deletes its backup
      # data (never "retain data"), so the vault is empty and can be
      # deleted, and nothing goes on being billed. Its twin,
      # vm_backup_suspend_protection_and_retain_data_on_destroy, cannot be
      # set beside it and stays at its default, false.
      vm_backup_stop_protection_and_retain_data_on_destroy = false
      # Items Terraform never made (a VM you protected by hand) are purged
      # when the vault is destroyed, rather than blocking it.
      purge_protected_items_from_vault_on_destroy = true
    }
  }
}
