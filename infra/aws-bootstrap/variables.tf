# variables.tf (aws-bootstrap)

variable "region" {
  type    = string
  default = "eu-west-2"
}

variable "github_sub_prefix" {
  description = "The repo's OIDC subject prefix. This repo uses GitHub's immutable subject format (owner@ownerId/repo@repoId), which survives renames; see GET /repos/{owner}/{repo}/actions/oidc/customization/sub. Only this repo's main branch may assume the deploy role."
  type        = string
  default     = "repo:sjohnston1972@87701935/wireguard@1381942334"
}

variable "alert_email" {
  description = "Where the AWS budget alarm emails. Taken from CF_ACCESS_ALLOWED_EMAIL by the bootstrap script."
  type        = string
}

variable "budget_usd" {
  description = "Account-wide monthly alarm, in dollars (AWS Budgets only counts in USD). 19 USD is about 15 GBP."
  type        = string
  default     = "19"
}
