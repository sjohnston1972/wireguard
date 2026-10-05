# main.tf
#
# Plain English: Terraform here only makes the resource group and hands the
# rest to a template. main.bicep (with its module vnet.bicep) is built to
# ARM JSON, main.json, by the pipeline's pinned Bicep before terraform init
# (lab.yml step 5; npm run labs-tf does the same in a copy). Terraform reads
# that file at plan, so the scope check sees the whole template before
# anything is built, and deploys it into rg-lab-<id> in Incremental mode as
# one deployment, bicep-main. The template makes a storage account, an NSG
# and a VNet with two subnets; the VNet's address space is the first /20 of
# the session's slot, passed in as the vnetCidr parameter. Destroying the
# deployment deletes what it made (versions.tf), and the group goes after.

resource "azurerm_resource_group" "lab" {
  name     = var.resource_group_name
  location = var.region
  tags     = var.tags
}

resource "azurerm_resource_group_template_deployment" "bicep" {
  name                = "bicep-main"
  resource_group_name = azurerm_resource_group.lab.name
  tags                = var.tags
  # Incremental: resources in the group that the template does not name are
  # left alone (Complete would delete them).
  deployment_mode = "Incremental"
  # Built from main.bicep by the pinned Bicep; never committed.
  template_content = file("${path.module}/main.json")
  parameters_content = jsonencode({
    vnetCidr   = { value = cidrsubnet(var.address_space, 2, 0) }
    namePrefix = { value = var.name_prefix }
    tags       = { value = var.tags }
  })
}
