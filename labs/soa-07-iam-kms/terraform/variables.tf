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

variable "name_prefix" {
  type        = string
  description = "a + lab number + 5 random lowercase characters (a01k3x9q), for globally unique names (S3 buckets, load balancers)."
}

variable "region" {
  type        = string
  description = "The session's region: always eu-west-2 (London)."
}

variable "tags" {
  type        = map(string)
  description = "cloudlabs-lab = <id>, cloudlabs-session = <session id>, project = cloudlabs: on everything, through default_tags."
}
