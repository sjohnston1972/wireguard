# variables.tf
#
# Plain English: the pipeline's variables this lab uses (spec §3.4). The
# pipeline makes the peering itself, so peered and gateway_vnet_id are not
# needed, and nothing needs a globally unique name, so neither is
# name_prefix. The second web VM and its load balancer run in
# secondary_region: the lab refuses to plan without one, or with the
# session's own region.

variable "resource_group_name" {
  type        = string
  description = "rg-lab-<id>. The lab creates it, and rg-lab-<id>-secondary beside it, and puts everything inside them."
}

variable "region" {
  type        = string
  description = "The Azure region for this session (uksouth): the global load balancer's home region."
}

variable "secondary_region" {
  type        = string
  description = "The second region (ukwest, uksouth's pair): vnet-ukw, vm-web2 and lb-ukw. Required by this lab."
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
