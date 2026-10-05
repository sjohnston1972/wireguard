# main.tf
#
# Plain English: two ways to run a container without a VM, and a registry.
#
# Azure Container Instances: aci-hello, one Linux container (Microsoft's
# aci-helloworld image from MCR) with 0.5 vCPU and 0.5 GB, running in a
# subnet delegated to ACI, so it has a private address only. Reach it over
# the tunnel when peered.
#
# Azure Container Apps: cae-lab, a consumption-only environment with no
# subnet and no workload profiles, so Azure builds no infrastructure group
# of its own outside rg-lab-<id> (ruling 7), and ca-hello, an app (MCR's
# k8se quickstart image) with public HTTPS ingress that scales to zero
# replicas when idle, so it costs nothing until it is called.
#
# Azure Container Registry: <prefix>acr, Basic, admin user off, and empty.
# Both containers come from MCR; nothing pulls from this registry (AcrPull
# is not on the labs' role allow-list). Push an image to it by hand.

locals {
  # The first /20 of the slot; ACI's delegated subnet is its first /24.
  vnet_cidr = cidrsubnet(var.address_space, 2, 0)
  aci_cidr  = cidrsubnet(local.vnet_cidr, 4, 0)
}

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

# ── Network: a subnet delegated to Azure Container Instances ─────────────

resource "azurerm_virtual_network" "lab" {
  name                = "vnet-lab"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  address_space       = [local.vnet_cidr]
  tags                = var.tags
}

resource "azurerm_subnet" "aci" {
  name                 = "snet-aci"
  resource_group_name  = azurerm_resource_group.lab.name
  virtual_network_name = azurerm_virtual_network.lab.name
  address_prefixes     = [local.aci_cidr]
  # The group pulls its image from MCR through Azure's default outbound
  # access: no NAT gateway, no public IP.
  default_outbound_access_enabled = true

  delegation {
    name = "aci"

    service_delegation {
      name    = "Microsoft.ContainerInstance/containerGroups"
      actions = ["Microsoft.Network/virtualNetworks/subnets/action"]
    }
  }
}

# ── Azure Container Instances: one small group, private address only ─────

resource "azurerm_container_group" "hello" {
  name                = "aci-hello"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  os_type             = "Linux"
  ip_address_type     = "Private"
  subnet_ids          = [azurerm_subnet.aci.id]
  restart_policy      = "Always"
  tags                = var.tags

  container {
    name   = "hello"
    image  = "mcr.microsoft.com/azuredocs/aci-helloworld:latest"
    cpu    = 0.5
    memory = 0.5

    ports {
      port     = 80
      protocol = "TCP"
    }
  }
}

# ── Azure Container Apps: consumption only, no subnet, scale to zero ──────

resource "azurerm_container_app_environment" "lab" {
  name                = "cae-lab"
  resource_group_name = azurerm_resource_group.lab.name
  location            = azurerm_resource_group.lab.location
  tags                = var.tags
}

resource "azurerm_container_app" "hello" {
  name                         = "ca-hello"
  container_app_environment_id = azurerm_container_app_environment.lab.id
  resource_group_name          = azurerm_resource_group.lab.name
  revision_mode                = "Single"
  tags                         = var.tags

  template {
    # No replicas until a request arrives (HTTP scaling is the default rule).
    min_replicas = 0
    max_replicas = 1

    container {
      name   = "hello"
      image  = "mcr.microsoft.com/k8se/quickstart:latest"
      cpu    = 0.25
      memory = "0.5Gi"
    }
  }

  ingress {
    external_enabled = true
    target_port      = 80

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
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
