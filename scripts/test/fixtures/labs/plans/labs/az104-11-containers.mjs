// az104-11-containers.mjs: lab 11's first-deploy plan, as
// labs/az104-11-containers/terraform/main.tf builds it (an ACI group in a
// delegated subnet, a consumption-only Container Apps environment with no
// subnet and an app, and an empty Basic registry). Fake ids; realistic.mjs
// adds what Azure computes (the environment's infrastructure group, the
// group's address, the app's FQDN), all unknown at plan.

import { ctx, IN_RG, REGION, ref, rgResource } from "../common.mjs";

export default () => {
  const c = ctx("az104-11-containers", "11");
  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      { address: "azurerm_virtual_network.lab", values: { name: "vnet-lab", resource_group_name: c.rg, location: REGION, address_space: ["10.64.64.0/20"], tags: c.tags }, refs: { ...IN_RG, address_space: ["local.vnet_cidr"] } },
      {
        address: "azurerm_subnet.aci",
        values: {
          name: "snet-aci",
          resource_group_name: c.rg,
          virtual_network_name: "vnet-lab",
          address_prefixes: ["10.64.64.0/24"],
          default_outbound_access_enabled: true,
          delegation: [{ name: "aci", service_delegation: [{ name: "Microsoft.ContainerInstance/containerGroups", actions: ["Microsoft.Network/virtualNetworks/subnets/action"] }] }],
        },
        refs: { resource_group_name: IN_RG.resource_group_name, virtual_network_name: ref("azurerm_virtual_network.lab", "name"), address_prefixes: ["local.aci_cidr"] },
      },
      {
        address: "azurerm_container_group.hello",
        values: {
          name: "aci-hello",
          resource_group_name: c.rg,
          location: REGION,
          os_type: "Linux",
          ip_address_type: "Private",
          restart_policy: "Always",
          tags: c.tags,
          container: [{ name: "hello", image: "mcr.microsoft.com/azuredocs/aci-helloworld:latest", cpu: 0.5, memory: 0.5, ports: [{ port: 80, protocol: "TCP" }] }],
        },
        unknown: ["subnet_ids"],
        refs: { ...IN_RG, subnet_ids: ref("azurerm_subnet.aci", "id") },
      },
      { address: "azurerm_container_app_environment.lab", values: { name: "cae-lab", resource_group_name: c.rg, location: REGION, tags: c.tags }, refs: IN_RG },
      {
        address: "azurerm_container_app.hello",
        values: {
          name: "ca-hello",
          resource_group_name: c.rg,
          revision_mode: "Single",
          tags: c.tags,
          template: [{ min_replicas: 0, max_replicas: 1, container: [{ name: "hello", image: "mcr.microsoft.com/k8se/quickstart:latest", cpu: 0.25, memory: "0.5Gi" }] }],
          ingress: [{ external_enabled: true, target_port: 80, traffic_weight: [{ latest_revision: true, percentage: 100 }] }],
        },
        unknown: ["container_app_environment_id"],
        refs: { resource_group_name: IN_RG.resource_group_name, tags: ["var.tags"], container_app_environment_id: ref("azurerm_container_app_environment.lab", "id") },
      },
      {
        address: "azurerm_container_registry.acr",
        values: { name: `${c.prefix}acr`, resource_group_name: c.rg, location: REGION, sku: "Basic", admin_enabled: false, tags: c.tags },
        refs: { ...IN_RG, name: ["var.name_prefix"] },
      },
    ],
  };
};
