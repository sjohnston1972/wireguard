# variables.tf (aws-bootstrap)

variable "region" {
  type    = string
  default = "eu-west-2"
}

variable "github_repo" {
  description = "owner/name. Only this repo's main branch may assume the deploy role."
  type        = string
  default     = "sjohnston1972/wireguard"
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
