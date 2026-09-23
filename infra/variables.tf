# variables.tf
#
# Plain English: these are the knobs. Static secrets arrive as TF_VAR_*
# environment variables set from GitHub repository secrets. Per-run values
# (region, size, peer list, tokens) arrive the same way but are set by the
# workflow from the JSON payload the Worker sent when Steven clicked Deploy.
#
# Anything marked sensitive = true is redacted from plan output and logs.

# ── Static, from repository secrets ─────────────────────────────────────────

variable "resource_group" {
  description = "Azure resource group that holds everything. Destroying it removes it all."
  type        = string
  default     = "rg-wg-ondemand"
}

variable "cloudflare_zone_id" {
  description = "Zone id of clydeford.net. The module only ever touches wg_dns_name inside it."
  type        = string
}

variable "ssh_public_key" {
  description = "Public half of the admin SSH key (ed25519)."
  type        = string
}

variable "wg_server_private_key" {
  description = "The fixed WireGuard server private key. Same on every rebuild so clients never change."
  type        = string
  sensitive   = true
}

# ── Per run, from the Worker's dispatch payload ─────────────────────────────

variable "region" {
  description = "Azure region."
  type        = string
  default     = "uksouth"
}

variable "vm_size" {
  description = "Azure VM SKU."
  type        = string
  default     = "Standard_B1s"
}

variable "wg_dns_name" {
  description = "The DNS name clients dial. The one and only record this module manages."
  type        = string
  default     = "wg.clydeford.net"

  validation {
    condition     = can(regex("^wg\\.clydeford\\.net$", var.wg_dns_name))
    error_message = "This module may only manage wg.clydeford.net. Refusing any other record name."
  }
}

variable "wg_port" {
  description = "WireGuard UDP listen port."
  type        = number
  default     = 51820
}

variable "wg_subnet" {
  description = "Tunnel subnet. The server takes the first host address."
  type        = string
  default     = "10.13.13.0/24"
}

variable "wg_subnet6" {
  description = "IPv6 tunnel subnet (unique local). Empty turns IPv6 off everywhere: tunnel, VNet and the IPv6 public IP."
  type        = string
  default     = "fd13:13::/64"
}

variable "loopback_ip" {
  description = "A loopback (dummy interface) address on the VM, outside the tunnel subnet. Ping it from a client to prove the VM routes between interfaces, not just that wg0 is up."
  type        = string
  default     = "10.13.255.1"
}

variable "vnet_cidr" {
  description = "Azure VNet address space."
  type        = string
  default     = "10.50.0.0/16"
}

variable "subnet_cidr" {
  description = "Subnet for the VM inside the VNet."
  type        = string
  default     = "10.50.1.0/24"
}

variable "vnet_cidr6" {
  description = "IPv6 VNet address space (Azure wants a /48). Used only when wg_subnet6 is set."
  type        = string
  default     = "fd50:50::/48"
}

variable "subnet_cidr6" {
  description = "IPv6 subnet for the VM (a /64 inside vnet_cidr6)."
  type        = string
  default     = "fd50:50:1::/64"
}

variable "home_lan_cidr" {
  description = "Home LAN behind the tunnel. Empty string disables the Azure route table."
  type        = string
  default     = ""
}

variable "ssh_allowed_cidr" {
  description = "CIDR allowed to SSH to the VM. Empty string means no SSH rule at all."
  type        = string
  default     = ""
}

variable "ssh_password" {
  description = "Per-deploy password for azureuser. Empty disables password login (key only). Set by the Worker, shown in the dashboard's secret panel."
  type        = string
  default     = ""
  sensitive   = true
}

variable "peers_json" {
  description = <<-EOT
    JSON array of WireGuard clients, e.g.
    [{"name":"laptop","public_key":"...","ip":"10.13.13.2"}]
    Rendered into wg0.conf at boot. The Worker also pushes changes live via the agent.
  EOT
  type        = string
  default     = "[]"
}

variable "agent_url" {
  description = "Where the VM's status agent POSTs every 30 seconds."
  type        = string
  default     = "https://wg-admin.clydeford.net/api/agent"
}

variable "agent_token" {
  description = "Per-deploy bearer token baked into the VM for the status agent. Empty disables the agent."
  type        = string
  default     = ""
  sensitive   = true
}

variable "run_id" {
  description = "The Worker's run id, tagged onto every Azure resource for traceability."
  type        = string
  default     = "manual"
}
