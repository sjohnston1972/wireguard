// scripts/test/fixtures/labs/plans/labs/az305-29-aks.mjs
//
// Plain English: lab 29's first-deploy plan, as `terraform show -json` prints
// it (realistic.mjs adds what azurerm 4.81.0 and time 0.14.2 compute). A VNet
// and the node subnet, the control plane's user-assigned identity with
// Network Contributor on that subnet (scope and principal unknown: built from
// ids), a one-minute wait, the AKS cluster and a Basic registry. The
// cluster's node resource group is known at plan ("${var.resource_group_name}-nodes");
// its subnet and identity ids are not. Left unset and so unknown at plan, as
// the provider computes them: the network profile's pod and service ranges,
// the node pool's OS SKU and max pods, the Kubernetes version, the kubelet
// identity and the other Optional and Computed blocks (UNSET_BLOCKS_UNKNOWN).

import { IN_RG, REGION, ctx, ref, rgResource } from "../common.mjs";

export default () => {
  const c = ctx("az305-29-aks", "29");
  const subnet = "azurerm_subnet.aks";
  const uai = "azurerm_user_assigned_identity.aks";
  return {
    lab: c.id,
    providers: ["azurerm", "time"],
    variables: c.variables,
    resources: [
      rgResource(c),
      { address: "azurerm_virtual_network.lab", values: { name: "vnet-lab", resource_group_name: c.rg, location: REGION, address_space: ["10.64.64.0/20"], tags: c.tags }, refs: { ...IN_RG, address_space: ["local.vnet_cidr"] } },
      {
        address: subnet,
        values: { name: "snet-aks", resource_group_name: c.rg, virtual_network_name: "vnet-lab", address_prefixes: ["10.64.64.0/24"], default_outbound_access_enabled: true },
        refs: { resource_group_name: IN_RG.resource_group_name, virtual_network_name: ref("azurerm_virtual_network.lab", "name"), address_prefixes: ["local.aks_cidr"] },
      },
      { address: uai, values: { name: `id-${c.prefix}-aks`, resource_group_name: c.rg, location: REGION, tags: c.tags }, refs: { ...IN_RG, name: ["var.name_prefix"] } },
      {
        address: "azurerm_role_assignment.aks_subnet",
        values: { role_definition_name: "Network Contributor", principal_type: "ServicePrincipal", skip_service_principal_aad_check: true },
        unknown: ["scope", "principal_id"],
        refs: { scope: ref(subnet, "id"), principal_id: ref(uai, "principal_id") },
      },
      { address: "time_sleep.aks_subnet_role", values: { create_duration: "60s" } },
      {
        address: "azurerm_kubernetes_cluster.aks",
        values: {
          name: "aks-lab",
          resource_group_name: c.rg,
          location: REGION,
          dns_prefix: c.prefix,
          sku_tier: "Free",
          node_resource_group: `${c.rg}-nodes`,
          node_os_upgrade_channel: "None",
          tags: c.tags,
          default_node_pool: [{ name: "system", vm_size: "Standard_B2s", node_count: 1, os_disk_size_gb: 64, vnet_subnet_id: "(unknown)", tags: c.tags }],
          identity: [{ type: "UserAssigned", identity_ids: ["(unknown)"] }],
          network_profile: [{ network_plugin: "azure", network_plugin_mode: "overlay", load_balancer_sku: "standard", outbound_type: "loadBalancer" }],
        },
        unknown: ["default_node_pool.0.vnet_subnet_id", "identity.0.identity_ids"],
        refs: {
          ...IN_RG,
          dns_prefix: ["var.name_prefix"],
          node_resource_group: ["var.resource_group_name"],
          "default_node_pool.0.vnet_subnet_id": ref(subnet, "id"),
          "default_node_pool.0.tags": ["var.tags"],
          "identity.0.identity_ids": ref(uai, "id"),
        },
      },
      {
        address: "azurerm_container_registry.acr",
        values: { name: `${c.prefix}acr`, resource_group_name: c.rg, location: REGION, sku: "Basic", admin_enabled: false, tags: c.tags },
        refs: { ...IN_RG, name: ["var.name_prefix"] },
      },
    ],
  };
};
