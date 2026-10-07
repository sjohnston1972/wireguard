# variables.tf
#
# Plain English: the pipeline's variables this lab uses (spec §3.4). It is
# never peered (everything is reached through Front Door, or from inside
# the environment), so peered and gateway_vnet_id are not needed.

variable "name_prefix" {
  type        = string
  description = "l + lab number + 5 random lowercase characters (l28k3x9q): the SQL server and the Front Door endpoint are named from it."

  validation {
    # Global DNS labels: <prefix>-sql and <prefix>-afd.
    condition     = can(regex("^[a-z0-9]{3,12}$", var.name_prefix))
    error_message = "name_prefix must be 3 to 12 lowercase letters and digits."
  }
}

variable "resource_group_name" {
  type        = string
  description = "rg-lab-<id>. The lab creates it and puts everything inside it; the Container Apps platform's own group is rg-lab-<id>-infra."
}

variable "region" {
  type        = string
  description = "The Azure region for this session (uksouth): the VNet, the environment, the SQL server and the endpoint."
}

variable "address_space" {
  type        = string
  description = "The session's /18 slot. Every address comes from cidrsubnet(var.address_space, ...)."
}

variable "admin_password" {
  type        = string
  description = "A per-session password for the SQL server's labadmin login (shown behind Show); the app tier gets it as a Container Apps secret."
  sensitive   = true
}

variable "tags" {
  type        = map(string)
  description = "project=wg-admin-labs, lab=<id>, session=<id>. Put them on every resource."
}
