# variables.tf
#
# Plain English: the pipeline's variables this lab uses (spec §3.4). No VNet
# and no VMs, so no address space, password or key.

variable "name_prefix" {
  type        = string
  description = "l + lab number + 5 random lowercase characters (l25k3x9q), for the accounts' globally unique names."

  validation {
    # Storage account names: 3 to 24 lowercase letters and digits; the
    # longest suffix here is "lake".
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
  description = "The Azure region for this session (the RA-GRS account's secondary is its pair)."
}

variable "tags" {
  type        = map(string)
  description = "project=wg-admin-labs, lab=<id>, session=<id>. Put them on every resource."
}
