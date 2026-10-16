# variables.tf
#
# Plain English: everything lab-aws.yml fills in that this lab uses (AWS labs
# spec §4). A lab declares only the ones it uses; labs-check refuses any other
# variable. Lab 12 has no network and no S3 bucket, so it keeps the id, the
# region, the session's password (it goes to the one Cognito user) and the tags.

variable "lab_id" {
  type        = string
  description = "The lab's id, e.g. soa-01-cloudwatch."
}

variable "region" {
  type        = string
  description = "The session's region: always eu-west-2 (London)."
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
