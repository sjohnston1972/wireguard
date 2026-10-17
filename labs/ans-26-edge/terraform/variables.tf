# variables.tf
#
# Plain English: the variables lab 26 uses (AWS labs spec §4), each declared
# exactly as the template writes it. secondary_region is eu-west-1 (Ireland).

variable "lab_id" {
  type        = string
  description = "The lab's id, e.g. soa-01-cloudwatch."
}

variable "name_prefix" {
  type        = string
  description = "a + lab number + 5 random lowercase characters (a01k3x9q), for globally unique names (S3 buckets, load balancers)."
}

variable "region" {
  type        = string
  description = "The session's region: always eu-west-2 (London)."
}

variable "secondary_region" {
  type        = string
  description = "eu-west-1 (Ireland) for a lab with regions.secondary; empty otherwise."
  default     = ""
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
