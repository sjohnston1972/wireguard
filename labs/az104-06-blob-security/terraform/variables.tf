# variables.tf
#
# Plain English: the pipeline's variables this lab uses (spec §3.4). It does
# not use peered or gateway_vnet_id: the pipeline's peer step makes the
# peering and links this lab's private DNS zone to the gateway VNet
# (lab.yaml dns_link), so Terraform never names the gateway.

variable "lab_id" {
  type        = string
  description = "The lab's id, az104-06-blob-security; Entra names start lab-<id>-."
}

variable "name_prefix" {
  type        = string
  description = "l + lab number + 5 random lowercase characters (l06k3x9q), for globally unique names."

  validation {
    # Storage account names are 3-24 lowercase letters and digits. The
    # pipeline's prefix is 8 characters; up to 12 plus the suffix here (4)
    # stays well inside 24.
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
