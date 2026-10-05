# variables.tf
#
# Plain English: the pipeline's variables this lab uses (spec §3.4). The lab
# cannot peer and has no VMs, so no peering variables and no password.

variable "name_prefix" {
  type        = string
  description = "l + lab number + 5 random lowercase characters (l12k3x9q), for globally unique names."

  validation {
    # The template's storage account is <prefix>bicep: 3-24 lowercase letters
    # and digits. The pipeline's prefix is 8 characters; main.bicep also
    # refuses one longer than 12.
    condition     = can(regex("^[a-z0-9]{3,12}$", var.name_prefix))
    error_message = "name_prefix must be 3 to 12 lowercase letters and digits."
  }
}

variable "resource_group_name" {
  type        = string
  description = "rg-lab-<id>. The lab creates it and puts everything inside it."
}

variable "region" {
  type        = string
  description = "The Azure region for this session."
}

variable "address_space" {
  type        = string
  description = "The session's /18 slot. Every address comes from cidrsubnet(var.address_space, ...)."
}

variable "tags" {
  type        = map(string)
  description = "project=wg-admin-labs, lab=<id>, session=<id>. Put them on every resource."
}
