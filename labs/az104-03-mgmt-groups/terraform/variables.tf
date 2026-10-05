# variables.tf
#
# Plain English: the pipeline fills these in (spec §3.4). This lab uses only
# these four; labs-check refuses anything else.

variable "lab_id" {
  type        = string
  description = "The lab's id, az104-03-mgmt-groups. Management groups and the policy definition start lab-<id>-."
}

variable "resource_group_name" {
  type        = string
  description = "rg-lab-<id>. The lab creates it (every lab does), though the management groups live above it."
}

variable "region" {
  type        = string
  description = "The Azure region for this session."
}

variable "tags" {
  type        = map(string)
  description = "project=wg-admin-labs, lab=<id>, session=<id>. Put them on every resource."
}
