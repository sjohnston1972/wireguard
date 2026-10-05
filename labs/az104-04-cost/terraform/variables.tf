# variables.tf
#
# Plain English: the pipeline fills these in (spec §3.4). This lab uses only
# these four; labs-check refuses anything else.

variable "lab_id" {
  type        = string
  description = "The lab's id, az104-04-cost. The budget and action group are named lab-<id>-..."
}

variable "resource_group_name" {
  type        = string
  description = "rg-lab-<id>. The lab creates it and puts everything inside it, the budget included."
}

variable "region" {
  type        = string
  description = "The Azure region for this session."
}

variable "tags" {
  type        = map(string)
  description = "project=wg-admin-labs, lab=<id>, session=<id>. Put them on every resource."
}
