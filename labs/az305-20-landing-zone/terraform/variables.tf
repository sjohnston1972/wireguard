# variables.tf
#
# Plain English: the pipeline fills these in (spec §3.4). This lab uses only
# these five; labs-check refuses anything else.

variable "lab_id" {
  type        = string
  description = "The lab's id, az305-20-landing-zone. Management groups, definitions and roles start lab-<id>-."
}

variable "name_prefix" {
  type        = string
  description = "l20 plus 5 random characters, for the managed identities' names (id-<prefix>-netops, id-<prefix>-appops)."
}

variable "resource_group_name" {
  type        = string
  description = "rg-lab-<id>. The lab creates it; the custom roles are assignable only here, and the identities live here."
}

variable "region" {
  type        = string
  description = "The Azure region for this session; also the only location the baseline initiative allows."
}

variable "tags" {
  type        = map(string)
  description = "project=wg-admin-labs, lab=<id>, session=<id>. Put them on every resource."
}
