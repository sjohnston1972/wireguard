# variables.tf
#
# Plain English: the pipeline fills these in (spec §3.4). This lab uses only
# these six; labs-check refuses anything else.

variable "lab_id" {
  type        = string
  description = "The lab's id, az104-01-identity. Every Entra name starts lab-<id>-."
}

variable "resource_group_name" {
  type        = string
  description = "rg-lab-<id>. The lab creates it and puts everything inside it."
}

variable "region" {
  type        = string
  description = "The Azure region for this session."
}

variable "admin_password" {
  type        = string
  description = "The per-session password; ann and ben sign in with it (shown behind Show)."
  sensitive   = true
}

variable "upn_domain" {
  type        = string
  description = "The tenant's primary domain for lab users (contoso.onmicrosoft.com), from LAB_UPN_DOMAIN."
  default     = ""

  validation {
    condition     = length(var.upn_domain) > 0
    error_message = "upn_domain is empty: put the tenant's primary onmicrosoft.com domain in LAB_UPN_DOMAIN (README, Labs: one-time setup)."
  }
}

variable "tags" {
  type        = map(string)
  description = "project=wg-admin-labs, lab=<id>, session=<id>. Put them on every resource."
}
