variable "resource_group_name" {
  type = string
}

variable "region" {
  type = string
}

variable "secondary_region" {
  type    = string
  default = ""

  validation {
    condition     = var.secondary_region != "" && var.secondary_region != var.region
    error_message = "This lab needs a secondary region other than the session's region."
  }
}

variable "address_space" {
  type = string
}

variable "admin_password" {
  type      = string
  sensitive = true
}

variable "tags" {
  type = map(string)
}
