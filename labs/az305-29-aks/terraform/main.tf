# main.tf
#
# Plain English: the smallest AKS cluster Azure will run. A Free-tier
# control plane (no charge) and one system node pool of a single
# Standard_B2s node (2 vCPU, 4 GiB: the B-series family has 10 vCPUs of
# quota per region), in a subnet of the session's slot, with Azure CNI
# Overlay: the node takes an address from the subnet, the pods take theirs
# from an overlay range that never touches the VNet. The pod and service
# ranges are left to AKS's defaults, which the readme names; they are
# outside the lab pool and every gateway range (labs-az305-aks.test.mjs).
#
# (V) at the first release test: Learn says B-series sizes are not supported
# for system node pools (the portal refuses them), and recommends two nodes;
# the AKS API is believed to accept one B2s node. If it refuses, the
# fallback is Standard_A2_v2 (2 vCPU, 4 GiB, about £0.066/h; its Av2 quota
# to check), a new lab version.
#
# Azure makes the cluster's node resource group itself: the node scale set,
# the Standard load balancer and its outbound public IP, the NSG and the
# kubelet identity. Left to Azure it would be MC_<group>_<cluster>_<region>,
# outside the lab; it is named rg-lab-<id>-nodes here, so the safety net,
# Verify clean and the orphan sweep (all rg-lab-<id>*) find it, and the scope
# check refuses any other name (rule azure-made-group). Deleting the cluster
# deletes it.
#
# Identity (spec §8): the control plane uses a user-assigned identity that
# exists before the cluster, so it can be given Network Contributor on the
# node subnet first (Learn: the way to do it outside the Azure CLI); the
# cluster waits a minute for that role to reach Azure Resource Manager.
# AcrPull for the kubelet identity is NOT assigned: it is not on the
# allow-list (labs/setup/allowed-roles.json), so attaching the registry is a
# Things to try step the learner does with their own rights.

locals {
  # The first /20 of the slot; the node subnet is its first /24 (overlay
  # pods need no subnet addresses, so a /24 holds many nodes).
  vnet_cidr = cidrsubnet(var.address_space, 2, 0)
  aks_cidr  = cidrsubnet(local.vnet_cidr, 4, 0)
}

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

# ── Network ───────────────────────────────────────────────────────────────

resource "azurerm_virtual_network" "lab" {
  name                = "vnet-lab"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.vnet_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "aks" {
  name                 = "snet-aks"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.lab.name
  address_prefixes     = [local.aks_cidr]
  # Ruling 37: said explicitly. The node leaves through the load balancer's
  # outbound rule (outbound_type loadBalancer), which takes precedence over
  # default outbound access, so this changes nothing while that rule exists.
  default_outbound_access_enabled = true
}

# ── The control plane's identity ──────────────────────────────────────────

resource "azurerm_user_assigned_identity" "aks" {
  name                = "id-${var.name_prefix}-aks"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags
}

# The node subnet is the lab's, outside the node resource group: the control
# plane needs to join it (node NICs, internal load balancers).
resource "azurerm_role_assignment" "aks_subnet" {
  scope                            = azurerm_subnet.aks.id
  role_definition_name             = "Network Contributor"
  principal_id                     = azurerm_user_assigned_identity.aks.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "time_sleep" "aks_subnet_role" {
  create_duration = "60s"

  depends_on = [azurerm_role_assignment.aks_subnet]
}

# ── The cluster ───────────────────────────────────────────────────────────

resource "azurerm_kubernetes_cluster" "aks" {
  name                = "aks-lab"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  dns_prefix          = var.name_prefix
  sku_tier            = "Free"
  node_resource_group = "${var.resource_group_name}-nodes"
  # No node image upgrade, and so no node reboot, in the middle of a session.
  node_os_upgrade_channel = "None"
  tags                    = var.tags

  default_node_pool {
    name            = "system"
    vm_size         = "Standard_B2s"
    node_count      = 1
    os_disk_size_gb = 64
    vnet_subnet_id  = azurerm_subnet.aks.id
    tags            = var.tags
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.aks.id]
  }

  network_profile {
    network_plugin      = "azure"
    network_plugin_mode = "overlay"
    load_balancer_sku   = "standard"
    outbound_type       = "loadBalancer"
  }

  depends_on = [time_sleep.aks_subnet_role]
}

# ── Azure Container Registry: Basic, admin user off, empty ───────────────

resource "azurerm_container_registry" "acr" {
  name                = "${var.name_prefix}acr"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  sku                 = "Basic"
  admin_enabled       = false
  tags                = var.tags
}
