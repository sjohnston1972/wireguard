# variables.tf
#
# Plain English: the pipeline's variables this lab uses (spec §3.4). It has
# no network of its own, so no address_space, and nothing to peer. The
# second container group runs in secondary_region: the lab refuses to plan
# without one, or with the session's own region.

variable "name_prefix" {
  type        = string
  description = "l + lab number + 5 random lowercase characters (l27k3x9q), for globally unique names."

  validation {
    # DNS labels: the container groups' <prefix>-uks and <prefix>-ukw, the
    # Traffic Manager name <prefix>-tm and the Front Door endpoint
    # <prefix>-afd. 12 characters plus a 4-character suffix stays short.
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
  description = "The Azure region for this session: the first container group's (uksouth)."
}

variable "secondary_region" {
  type        = string
  description = "The second container group's region (ukwest, uksouth's pair). Required by this lab."
  default     = ""

  validation {
    condition     = var.secondary_region != "" && var.secondary_region != var.region
    error_message = "This lab needs a secondary region other than the session's region (ukwest for uksouth)."
  }
}

variable "tags" {
  type        = map(string)
  description = "project=wg-admin-labs, lab=<id>, session=<id>. Put them on every resource."
}
