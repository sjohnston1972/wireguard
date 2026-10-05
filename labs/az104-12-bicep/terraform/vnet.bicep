// vnet.bicep
//
// Plain English: main.bicep's module. A VNet whose address space is the
// cidr it is given, with one /24 subnet of it per entry in subnets, each
// with the NSG main.bicep made. Bicep turns a module into a nested
// deployment in the built template.

@description('The VNet\'s address space (main.bicep\'s vnetCidr).')
param cidr string

@description('The NSG every subnet uses.')
param nsgId string

param location string
param tags object

@description('Each subnet: its name and which /24 of cidr it takes.')
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
output subnetPrefixes array = [for (s, i) in subnets: vnet.properties.subnets[i].properties.addressPrefix]
