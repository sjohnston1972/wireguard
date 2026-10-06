# variables.tf
#
# Plain English: the pipeline's variables this lab uses (spec §3.4). lab_id
# and upn_domain name the Entra user (lab-<id>-vpnuser@<domain>, so tear-down
# finds it by its prefix). The pipeline makes the peering itself, so peered
# and gateway_vnet_id are not needed here, and nothing needs a globally
# unique name, so neither is name_prefix.

variable "lab_id" {
  type        = string
  description = "The lab's id; Entra names start lab-<id>-."
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

variable "admin_password" {
  type        = string
  description = "A per-session password for the VM's azureuser and the lab user (shown behind Show)."
  sensitive   = true
}

variable "ssh_public_key" {
  type        = string
  description = "The operator's SSH public key for the VM; empty means password only."
  default     = ""
}

variable "upn_domain" {
  type        = string
  description = "The tenant's primary domain for the lab user (contoso.onmicrosoft.com), from LAB_UPN_DOMAIN."
  default     = ""
}

variable "tags" {
  type        = map(string)
  description = "project=wg-admin-labs, lab=<id>, session=<id>. Put them on every resource."
}
