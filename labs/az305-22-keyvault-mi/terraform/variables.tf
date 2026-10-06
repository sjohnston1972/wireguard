# variables.tf
#
# Plain English: the pipeline's variables this lab uses (spec §3.4). The
# pipeline makes the peering itself, so peered and gateway_vnet_id are not
# needed.

variable "name_prefix" {
  type        = string
  description = "l22 plus 5 random characters: the vault's globally unique name (<prefix>kv) and the identity's (id-<prefix>-app)."
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
