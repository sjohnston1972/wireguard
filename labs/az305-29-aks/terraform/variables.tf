# variables.tf
#
# Plain English: the pipeline's variables this lab uses (spec §3.4). The
# pipeline makes the peering itself, so peered and gateway_vnet_id are not
# needed. The node has no password or SSH key of its own here: AKS manages
# it, and the learner reaches workloads with kubectl.

variable "name_prefix" {
  type        = string
  description = "l29 plus 5 random characters: the registry's globally unique name (<prefix>acr), the cluster's DNS prefix and the identity's name (id-<prefix>-aks)."
}

variable "resource_group_name" {
  type        = string
  description = "rg-lab-<id>. The lab creates it and puts everything inside it; AKS's node resource group is <this>-nodes."
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
