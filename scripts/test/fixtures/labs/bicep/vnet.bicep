// vnet.bicep: storage-vnet.bicep's module, a VNet cut from the /20 it is given.

param cidr string
param nsgId string
param location string
param tags object
param subnets array

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: 'vnet-bicep'
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        cidr
      ]
    }
    subnets: [
      for s in subnets: {
        name: s.name
        properties: {
          addressPrefix: cidrSubnet(cidr, 24, s.index)
          networkSecurityGroup: {
            id: nsgId
          }
        }
      }
    ]
  }
}

output id string = vnet.id
