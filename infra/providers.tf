# providers.tf
#
# Plain English: this file says which "drivers" Terraform needs to talk to
# Azure and Cloudflare, and pins their versions so a rebuild next year behaves
# exactly like today. Think of it as pinning the firmware version on a switch
# so the config you wrote keeps working.
#
# Credentials are NOT here. The Azure provider reads ARM_CLIENT_ID,
# ARM_CLIENT_SECRET, ARM_TENANT_ID and ARM_SUBSCRIPTION_ID from the
# environment; the Cloudflare provider reads CLOUDFLARE_API_TOKEN. The GitHub
# Actions workflow sets those from repository secrets.

terraform {
  required_version = ">= 1.10.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "azurerm" {
  # azurerm 4.x insists the subscription is named explicitly. It is read from
  # ARM_SUBSCRIPTION_ID so it never has to be written into this repo.
  features {
    resource_group {
      # Let "terraform destroy" remove the group even if something unexpected
      # was left inside it. The whole point is that destroy always reaches £0.
      prevent_deletion_if_contains_resources = false
    }
  }
}

provider "cloudflare" {
  # api_token comes from CLOUDFLARE_API_TOKEN in the environment. In the
  # workflow that variable is filled from the narrow CLOUDFLARE_DNS_TOKEN
  # secret, never the broad account token.
}
