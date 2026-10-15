# variables.tf
#
# Plain English: everything lab-aws.yml fills in (AWS labs spec §4). A lab
# declares only the ones it uses; labs-check refuses any other variable. The
# template declares them all so a new lab can copy it and delete what it does
# not need (keep secondary_region only with regions.secondary).

variable "lab_id" {
  type        = string
  description = "The lab's id, e.g. soa-01-cloudwatch."
}

variable "region" {
  type        = string
  description = "The session's region: always eu-west-2 (London)."
}

variable "address_space" {
  type        = string
  description = "The session's /18 slot. Every address comes from cidrsubnet(var.address_space, ...)."
}

variable "gateway_cidr" {
  type        = string
  description = "The VPN server's VPC range (the Worker's AZURE_VNET_CIDR): the one other address a lab may write (ruling A10). No default: lab-aws.yml always sets it, and the lint refuses literal CIDRs."
}

variable "admin_password" {
  type        = string
  description = "The session's password for labadmin on every instance (ruling A12)."
  sensitive   = true
}

variable "tags" {
  type        = map(string)
  description = "cloudlabs-lab = <id>, cloudlabs-session = <session id>, project = cloudlabs: on everything, through default_tags."
}
