# variables.tf
#
# Plain English: the pipeline fills these in (spec §3.4). This lab uses only
# these five; labs-check refuses anything else.

variable "lab_id" {
  type        = string
  description = "The lab's id, az305-21-monitoring-scale. The policy definition and assignments start lab-<id>-."
}

variable "name_prefix" {
  type        = string
  description = "l21 plus 5 random characters: the Key Vault's globally unique name is <prefix>kv."
}

variable "resource_group_name" {
  type        = string
  description = "rg-lab-<id>. The lab creates it and puts everything inside it; the policy is assigned here."
}

variable "region" {
  type        = string
  description = "The Azure region for this session; also the policy assignment's location (it has an identity)."
}

variable "tags" {
  type        = map(string)
  description = "project=wg-admin-labs, lab=<id>, session=<id>. Put them on every resource."
}
