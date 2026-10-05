// main.bicep
//
// Plain English: lab 12's template, the thing to read, change and redeploy.
// It makes a storage account, a network security group and, through one
// local module (vnet.bicep), a VNet with two subnets that use the NSG. The
// pipeline builds it to ARM JSON (main.json) with the pinned Bicep before
// Terraform runs, and Terraform deploys that JSON into rg-lab-<id> with
// azurerm_resource_group_template_deployment, so the scope check reads the
// whole template before anything is built. Everything goes into the
// deployment's own resource group (no targetScope, no scope or resourceGroup
// settings), and every address comes from the vnetCidr parameter.

@description('The VNet\'s address space: cidrsubnet(var.address_space, 2, 0), passed in by Terraform.')
param vnetCidr string

@description('name_prefix from the pipeline: a storage account needs a globally unique name.')
@minLength(3)
@maxLength(12)
param namePrefix string

@description('Where everything goes: the resource group\'s own region.')
param location string = resourceGroup().location

@description('The session\'s tags, put on every resource.')
param tags object = {}

@description('The storage account\'s default access tier. Redeploy with Cool to see an in-place change.')
@allowed([
  'Hot'
  'Cool'
])
param accessTier string = 'Hot'

// Two /24s of the VNet, each with the NSG.
var subnets = [
  {
    name: 'snet-web'
    index: 0
  }
  {
    name: 'snet-app'
    index: 1
  }
]

resource sa 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: '${namePrefix}bicep'
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: accessTier
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource nsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: 'nsg-bicep'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'allow-https-from-vnet'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: 'VirtualNetwork'
          destinationPortRange: '443'
        }
      }
    ]
  }
}

module vnet 'vnet.bicep' = {
  name: 'vnet'
  params: {
    cidr: vnetCidr
    nsgId: nsg.id
    location: location
    tags: tags
    subnets: subnets
  }
}

output storageAccountName string = sa.name
output vnetId string = vnet.outputs.id
output subnetPrefixes array = vnet.outputs.subnetPrefixes
