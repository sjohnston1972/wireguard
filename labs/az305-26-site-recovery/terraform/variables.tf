# variables.tf
#
# Plain English: the pipeline's variables this lab uses (spec §3.4). The
# pipeline makes the peering itself, so peered and gateway_vnet_id are not
# needed here. secondary_region is where Site Recovery replicates to: the
# lab refuses to plan without one, or with the session's own region.

variable "name_prefix" {
  type        = string
  description = "l + lab number + 5 random lowercase characters (l26k3x9q), for globally unique names."

  validation {
    # Storage account names are 3-24 lowercase letters and digits. The
    # pipeline's prefix is 8 characters; up to 12 plus the suffix here (5)
    # stays well inside 24 (the cache account is <prefix>cache).
    condition     = can(regex("^[a-z0-9]{3,12}$", var.name_prefix))
    error_message = "name_prefix must be 3 to 12 lowercase letters and digits."
  }
}

variable "resource_group_name" {
  type        = string
  description = "rg-lab-<id>. The lab creates it, and rg-lab-<id>-secondary beside it, and puts everything inside them."
}

variable "region" {
  type        = string
  description = "The Azure region for this session: where the VM runs (uksouth)."
}

variable "secondary_region" {
  type        = string
  description = "The region Site Recovery replicates to (ukwest, uksouth's pair). Required by this lab."
  default     = ""

  validation {
    condition     = var.secondary_region != "" && var.secondary_region != var.region
    error_message = "This lab needs a secondary region other than the session's region (ukwest for uksouth)."
  }
}

variable "address_space" {
  type        = string
  description = "The session's /18 slot. Every address comes from cidrsubnet(var.address_space, ...)."
}

variable "admin_password" {
  type        = string
  description = "A per-session password for the VM's azureuser (shown behind Show)."
  sensitive   = true
}

variable "ssh_public_key" {
  type        = string
  description = "The operator's SSH public key for the VM; empty means password only."
  default     = ""
}

variable "tags" {
  type        = map(string)
  description = "project=wg-admin-labs, lab=<id>, session=<id>. Put them on every resource."
}
