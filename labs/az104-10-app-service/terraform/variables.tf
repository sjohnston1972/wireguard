# variables.tf
#
# Plain English: the pipeline's variables this lab uses (spec §3.4). The lab
# has no VNet and no VMs, so no address space and no admin password; it
# cannot peer, so neither peered nor gateway_vnet_id.

variable "name_prefix" {
  type        = string
  description = "l + lab number + 5 random lowercase characters (l10k3x9q), for globally unique names."

  validation {
    # The web app's name is <prefix>-web and becomes <prefix>-web.azurewebsites.net
    # (2-60 letters, digits and hyphens); the pipeline's prefix is 8 characters.
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

variable "tags" {
  type        = map(string)
  description = "project=wg-admin-labs, lab=<id>, session=<id>. Put them on every resource."
}
