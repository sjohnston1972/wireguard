# variables.tf
#
# Plain English: the pipeline's variables this lab uses (spec §3.4). The
# pipeline makes the peering and the gateway's DNS link itself, so peered
# and gateway_vnet_id are not needed here. The lab works in two regions:
# the session's (uksouth) and its pair (ukwest), where the vCore quota is.

variable "name_prefix" {
  type        = string
  description = "l + lab number + 5 random lowercase characters (l23k3x9q): the servers and the failover group listener are named from it."

  validation {
    # Server names are global DNS labels: lowercase letters, digits and hyphens.
    condition     = can(regex("^[a-z0-9]{3,12}$", var.name_prefix))
    error_message = "name_prefix must be 3 to 12 lowercase letters and digits."
  }
}

variable "resource_group_name" {
  type        = string
  description = "rg-lab-<id>. The lab creates it and rg-lab-<id>-secondary, and puts everything inside them."
}

variable "region" {
  type        = string
  description = "The Azure region for this session (uksouth): the primary server, the VNet and the private endpoints."
}

variable "secondary_region" {
  type        = string
  description = "The session region's pair (ukwest): the secondary server, the geo-secondary and the serverless database."
  default     = ""

  validation {
    # The geo-secondary must be somewhere else, and there must be somewhere.
    condition     = var.secondary_region != "" && var.secondary_region != var.region
    error_message = "This lab needs a secondary region other than the session's region (uksouth's pair is ukwest)."
  }
}

variable "address_space" {
  type        = string
  description = "The session's /18 slot. Every address comes from cidrsubnet(var.address_space, ...)."
}

variable "admin_password" {
  type        = string
  description = "A per-session password for the servers' labadmin login (shown behind Show)."
  sensitive   = true
}

variable "tags" {
  type        = map(string)
  description = "project=wg-admin-labs, lab=<id>, session=<id>. Put them on every resource."
}
