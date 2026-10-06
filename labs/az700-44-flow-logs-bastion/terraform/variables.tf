# variables.tf
#
# Plain English: the pipeline's variables this lab uses (spec §3.4). The
# pipeline makes the peering itself, so peered and gateway_vnet_id are not
# needed. lab_id names the flow log lab-<id>-vnet, the name the safety net
# and the orphan sweep look for (scope exception S2, ruling 48).

variable "lab_id" {
  type        = string
  description = "The lab's id: the flow log is lab-<id>-vnet."
}

variable "name_prefix" {
  type        = string
  description = "l44 plus 5 random characters: the flow-log storage account's globally unique name (<prefix>flow)."
}

variable "resource_group_name" {
  type        = string
  description = "rg-lab-<id>. The lab creates it and puts everything inside it, but the flow log (NetworkWatcherRG, S2)."
}

variable "region" {
  type        = string
  description = "The Azure region for this session; the flow log goes on that region's NetworkWatcher_<region>."
}

variable "address_space" {
  type        = string
  description = "The session's /18 slot. Every address comes from cidrsubnet(var.address_space, ...)."
}

variable "admin_password" {
  type        = string
  description = "A per-session password for the VMs' azureuser (shown behind Show)."
  sensitive   = true
}

variable "ssh_public_key" {
  type        = string
  description = "The operator's SSH public key for the VMs; empty means password only."
  default     = ""
}

variable "tags" {
  type        = map(string)
  description = "project=wg-admin-labs, lab=<id>, session=<id>. Put them on every resource."
}
