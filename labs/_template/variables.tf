# variables.tf
#
# Plain English: everything the pipeline fills in (spec §3.4). A lab declares
# only the ones it uses; labs-check refuses any other variable. The template
# declares them all so a new lab can copy it and delete what it does not need.

variable "lab_id" {
  type        = string
  description = "The lab's id, e.g. az104-06-blob-security."
}

variable "name_prefix" {
  type        = string
  description = "l + lab number + 5 random lowercase characters (l06k3x9q), for globally unique names."
}

variable "resource_group_name" {
  type        = string
  description = "rg-lab-<id>. The lab creates it and puts everything inside it."
}

variable "region" {
  type        = string
  description = "The Azure region for this session."
}

variable "secondary_region" {
  type        = string
  description = "A second region for cross-region labs; empty otherwise."
  default     = ""
}

variable "address_space" {
  type        = string
  description = "The session's /18 slot. Every address comes from cidrsubnet(var.address_space, ...)."
}

variable "peered" {
  type        = bool
  description = "Whether this session peers to the gateway's VNet."
  default     = false
}

variable "gateway_vnet_id" {
  type        = string
  description = "The gateway VNet's id when peered (only for a private DNS zone link); empty otherwise."
  default     = ""
}

variable "admin_password" {
  type        = string
  description = "A per-session password for lab VMs and users."
  sensitive   = true
}

variable "ssh_public_key" {
  type        = string
  description = "The operator's SSH public key for lab VMs."
  default     = ""
}

variable "upn_domain" {
  type        = string
  description = "The tenant's primary domain for lab users (contoso.onmicrosoft.com)."
  default     = ""
}

variable "tags" {
  type        = map(string)
  description = "project=wg-admin-labs, lab=<id>, session=<id>. Put them on every resource."
}
