// az104-12-bicep.mjs: lab 12's first-deploy plan, as labs/az104-12-bicep/terraform/main.tf
// builds it: one azurerm_resource_group_template_deployment of main.json, the
// ARM template the pinned Bicep (0.47.16) builds from main.bicep and its
// module vnet.bicep. TEMPLATE below is that build, so lab-plans.test.mjs runs
// the real template through lab-scope (templateProblems inside checkPlan);
// labs-compute.test.mjs rebuilds it with the pinned Bicep (when cached) and
// fails if it no longer equals TEMPLATE: rebuild and paste after any change to
// a .bicep file. template_content is known at plan (file() of the built JSON);
// output_content is not. Fake ids.

import { ctx, IN_RG, rgResource } from "../common.mjs";

/** main.json as the pinned Bicep builds it from main.bicep and vnet.bicep. */
export const TEMPLATE = {
  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  "contentVersion": "1.0.0.0",
  "metadata": {
    "_generator": {
      "name": "bicep",
      "version": "0.47.16.16243",
      "templateHash": "2625452267629033834"
    }
  },
  "parameters": {
    "vnetCidr": {
      "type": "string",
      "metadata": {
        "description": "The VNet's address space: cidrsubnet(var.address_space, 2, 0), passed in by Terraform."
      }
    },
    "namePrefix": {
      "type": "string",
      "minLength": 3,
      "maxLength": 12,
      "metadata": {
        "description": "name_prefix from the pipeline: a storage account needs a globally unique name."
      }
    },
    "location": {
      "type": "string",
      "defaultValue": "[resourceGroup().location]",
      "metadata": {
        "description": "Where everything goes: the resource group's own region."
      }
    },
    "tags": {
      "type": "object",
      "defaultValue": {},
      "metadata": {
        "description": "The session's tags, put on every resource."
      }
    },
    "accessTier": {
      "type": "string",
      "defaultValue": "Hot",
      "allowedValues": [
        "Hot",
        "Cool"
      ],
      "metadata": {
        "description": "The storage account's default access tier. Redeploy with Cool to see an in-place change."
      }
    }
  },
  "variables": {
    "subnets": [
      {
        "name": "snet-web",
        "index": 0
      },
      {
        "name": "snet-app",
        "index": 1
      }
    ]
  },
  "resources": [
    {
      "type": "Microsoft.Storage/storageAccounts",
      "apiVersion": "2023-05-01",
      "name": "[format('{0}bicep', parameters('namePrefix'))]",
      "location": "[parameters('location')]",
      "tags": "[parameters('tags')]",
      "sku": {
        "name": "Standard_LRS"
      },
      "kind": "StorageV2",
      "properties": {
        "accessTier": "[parameters('accessTier')]",
        "minimumTlsVersion": "TLS1_2",
        "allowBlobPublicAccess": false,
        "supportsHttpsTrafficOnly": true
      }
    },
    {
      "type": "Microsoft.Network/networkSecurityGroups",
      "apiVersion": "2024-05-01",
      "name": "nsg-bicep",
      "location": "[parameters('location')]",
      "tags": "[parameters('tags')]",
      "properties": {
        "securityRules": [
          {
            "name": "allow-https-from-vnet",
            "properties": {
              "priority": 100,
              "direction": "Inbound",
              "access": "Allow",
              "protocol": "Tcp",
              "sourceAddressPrefix": "VirtualNetwork",
              "sourcePortRange": "*",
              "destinationAddressPrefix": "VirtualNetwork",
              "destinationPortRange": "443"
            }
          }
        ]
      }
    },
    {
      "type": "Microsoft.Resources/deployments",
      "apiVersion": "2025-04-01",
      "name": "vnet",
      "properties": {
        "expressionEvaluationOptions": {
          "scope": "inner"
        },
        "mode": "Incremental",
        "parameters": {
          "cidr": {
            "value": "[parameters('vnetCidr')]"
          },
          "nsgId": {
            "value": "[resourceId('Microsoft.Network/networkSecurityGroups', 'nsg-bicep')]"
          },
          "location": {
            "value": "[parameters('location')]"
          },
          "tags": {
            "value": "[parameters('tags')]"
          },
          "subnets": {
            "value": "[variables('subnets')]"
          }
        },
        "template": {
          "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
          "contentVersion": "1.0.0.0",
          "metadata": {
            "_generator": {
              "name": "bicep",
              "version": "0.47.16.16243",
              "templateHash": "13191340937620678329"
            }
          },
          "parameters": {
            "cidr": {
              "type": "string",
              "metadata": {
                "description": "The VNet's address space (main.bicep's vnetCidr)."
              }
            },
            "nsgId": {
              "type": "string",
              "metadata": {
                "description": "The NSG every subnet uses."
              }
            },
            "location": {
              "type": "string"
            },
            "tags": {
              "type": "object"
            },
            "subnets": {
              "type": "array",
              "metadata": {
                "description": "Each subnet: its name and which /24 of cidr it takes."
              }
            }
          },
          "resources": [
            {
              "type": "Microsoft.Network/virtualNetworks",
              "apiVersion": "2024-05-01",
              "name": "vnet-bicep",
              "location": "[parameters('location')]",
              "tags": "[parameters('tags')]",
              "properties": {
                "copy": [
                  {
                    "name": "subnets",
                    "count": "[length(parameters('subnets'))]",
                    "input": {
                      "name": "[parameters('subnets')[copyIndex('subnets')].name]",
                      "properties": {
                        "addressPrefix": "[cidrSubnet(parameters('cidr'), 24, parameters('subnets')[copyIndex('subnets')].index)]",
                        "networkSecurityGroup": {
                          "id": "[parameters('nsgId')]"
                        }
                      }
                    }
                  }
                ],
                "addressSpace": {
                  "addressPrefixes": [
                    "[parameters('cidr')]"
                  ]
                }
              }
            }
          ],
          "outputs": {
            "id": {
              "type": "string",
              "value": "[resourceId('Microsoft.Network/virtualNetworks', 'vnet-bicep')]"
            },
            "subnetPrefixes": {
              "type": "array",
              "copy": {
                "count": "[length(parameters('subnets'))]",
                "input": "[reference(resourceId('Microsoft.Network/virtualNetworks', 'vnet-bicep'), '2024-05-01').subnets[copyIndex()].properties.addressPrefix]"
              }
            }
          }
        }
      },
      "dependsOn": [
        "[resourceId('Microsoft.Network/networkSecurityGroups', 'nsg-bicep')]"
      ]
    }
  ],
  "outputs": {
    "storageAccountName": {
      "type": "string",
      "value": "[format('{0}bicep', parameters('namePrefix'))]"
    },
    "vnetId": {
      "type": "string",
      "value": "[reference(resourceId('Microsoft.Resources/deployments', 'vnet'), '2025-04-01').outputs.id.value]"
    },
    "subnetPrefixes": {
      "type": "array",
      "value": "[reference(resourceId('Microsoft.Resources/deployments', 'vnet'), '2025-04-01').outputs.subnetPrefixes.value]"
    }
  }
};

export default () => {
  const c = ctx("az104-12-bicep", "12");
  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      {
        address: "azurerm_resource_group_template_deployment.bicep",
        values: {
          name: "bicep-main",
          resource_group_name: c.rg,
          deployment_mode: "Incremental",
          template_content: `${JSON.stringify(TEMPLATE, null, 2)}\n`,
          // jsonencode() sorts keys; the /20 is cidrsubnet(var.address_space, 2, 0) of slot 1.
          parameters_content: JSON.stringify({ namePrefix: { value: c.prefix }, tags: { value: c.tags }, vnetCidr: { value: "10.64.64.0/20" } }),
          tags: c.tags,
        },
        refs: {
          resource_group_name: IN_RG.resource_group_name,
          template_content: ["path.module"],
          parameters_content: ["var.address_space", "var.name_prefix", "var.tags"],
          tags: ["var.tags"],
        },
      },
    ],
  };
};
