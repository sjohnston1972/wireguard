# variables.tf (AWS)
#
# Plain English: the knobs for the AWS build. Same names and meanings as the
# Azure root (infra/variables.tf) so the workflow and the Worker pass the same
# values to either cloud. Azure-only knobs (resource group, IPv6 VNet block,
# firewall bundle) are not declared; a TF_VAR_ with no matching variable is ignored.

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

variable "workload_subnet_cidr" {
  description = "Subnet for servers behind the WireGuard firewall (the test VM and anything else you deploy)."
  type        = string
  default     = "10.50.2.0/24"
}

variable "test_vm" {
  description = "Build the small test VM in the workloads subnet."
  type        = bool
  default     = false
}

variable "published_ports" {
  description = "Public ports forwarded by the VM to servers behind it (from the Firewall tab), opened in the NSG one rule each: protocol (Tcp/Udp), port, allowed source (\"*\" = anywhere)."
  type = list(object({
    name     = string
    protocol = string
    port     = string
    source   = string
  }))
  default = []

  validation {
    condition     = alltrue([for p in var.published_ports : contains(["Tcp", "Udp"], p.protocol) && can(regex("^published-", p.name))])
    error_message = "Each published port needs protocol Tcp or Udp and a name starting \"published-\"."
  }
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
  description = "Per-deploy password for the VM's admin user. Empty disables password login (key only). Set by the Worker, shown in the dashboard's secret panel."
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

variable "region" {
  description = "AWS region."
  type        = string
  default     = "eu-west-2"
}

variable "vm_size" {
  description = "EC2 instance type for the headend. A 'g' type (t4g) is ARM; the AMI follows."
  type        = string
  default     = "t4g.micro"
}

variable "test_vm_size" {
  description = "EC2 instance type for the optional test VM. Must be the same CPU family as vm_size."
  type        = string
  default     = "t4g.nano"
}

variable "boot_bundle_sha256" {
  description = "SHA-256 of boot/<run id>.tgz in R2 (wg-aws.yml). Empty only for destroy."
  type        = string
  default     = ""
  validation {
    condition     = var.boot_bundle_sha256 == "" || can(regex("^[0-9a-f]{64}$", var.boot_bundle_sha256))
    error_message = "boot_bundle_sha256 must be 64 hex characters."
  }
}
