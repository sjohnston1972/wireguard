# variables.tf
#
# Plain English: the pipeline's variables this lab uses (spec §3.4). The lab
# is never peered (Front Door is the way in), so peered and gateway_vnet_id
# are not needed. name_prefix makes the Front Door endpoint's name, which is
# global.

variable "name_prefix" {
  type        = string
  description = "l42 plus 5 random characters: the Front Door endpoint's globally unique name (<prefix>-afd)."
}

variable "resource_group_name" {
  type        = string
  description = "rg-lab-<id>. The lab creates it and puts everything inside it."
}

variable "region" {
  type        = string
  description = "The Azure region for this session: the VM, the load balancer, the Private Link service and Front Door's private endpoint."
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
