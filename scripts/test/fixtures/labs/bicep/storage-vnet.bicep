// storage-vnet.bicep: the shape of lab 12's template, for lab-scope's
// templateProblems test. Built with the pinned Bicep (scripts/lib/bicep.mjs):
//   bicep build storage-vnet.bicep --outfile storage-vnet.json
// The user-defined type makes Bicep emit languageVersion 2.0 (symbolic
// resources), and the module becomes a nested deployment, as lab 12's will.

@description('The /20 for the VNet: cidrsubnet(var.address_space, 2, 0), passed in by Terraform.')
param vnetCidr string

@description('name_prefix from the pipeline, for the storage account\'s globally unique name.')
param namePrefix string

param location string = resourceGroup().location
param tags object = {}

@description('A subnet: its name and its /24 within the VNet.')
type subnetSpec = {
  name: string
  index: int
}

param subnets subnetSpec[] = [
  { name: 'snet-web', index: 0 }
  { name: 'snet-app', index: 1 }
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
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource nsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: 'nsg-bicep'
  location: location
  tags: tags
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
