# variables.tf
#
# Plain English: the pipeline fills these in (spec §3.4). This lab uses only
# these five; labs-check refuses anything else.

variable "lab_id" {
  type        = string
  description = "The lab's id, az104-02-policy. Policy definitions and assignments start lab-<id>-."
}

variable "name_prefix" {
  type        = string
  description = "l + lab number + 5 random lowercase characters (l02k3x9q), for the storage account's globally unique name."
}

variable "resource_group_name" {
  type        = string
  description = "rg-lab-<id>. The lab creates it and puts everything inside it."
}

variable "region" {
  type        = string
  description = "The Azure region for this session; also the only location the Allowed locations assignment permits."
}

variable "tags" {
  type        = map(string)
  description = "project=wg-admin-labs, lab=<id>, session=<id>. Put them on every resource."
}
