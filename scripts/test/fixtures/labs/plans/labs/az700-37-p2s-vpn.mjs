// az700-37-p2s-vpn.mjs
//
// Plain English: lab 37's first-deploy plan, written out from
// labs/az700-37-p2s-vpn/terraform/main.tf with a real session's values at
// slot 31 (10.71.192.0/18): vnet-hub 10.71.192.0/20 (GatewaySubnet
// 10.71.192.0/27, snet-app 10.71.193.0/24) and the point-to-site client
// pool 10.71.255.0/24, the last /24 of the fourth /20.
//
// The client config is read at plan, so the gateway's Entra ID tenant and
// issuer (built from its tenant_id) are known; the ids are not. The lab
// user's password is the session's (sensitive).

import { ctx, IN_RG, linuxVm, ref, REGION, rgResource, SUB, TENANT, UPN } from "../common.mjs";

const PIPELINE_OBJECT_ID = "6a1f2e3d-4c5b-4a69-8f7e-0d1c2b3a4f5e";
const PIPELINE_CLIENT_ID = "0b9c8d7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e";

export default () => {
  const c = ctx("az700-37-p2s-vpn", "37", { slot: 31 });
  const inRg = { resource_group_name: IN_RG.resource_group_name };
  const subnet = (key, name, cidr) => ({
    address: `azurerm_subnet.${key}`,
    values: { name, resource_group_name: c.rg, virtual_network_name: "vnet-hub", address_prefixes: [cidr], default_outbound_access_enabled: true },
    refs: { ...inRg, virtual_network_name: ref("azurerm_virtual_network.hub", "name"), address_prefixes: [`local.${key}_cidr`] },
  });
  const tenant = ref("data.azurerm_client_config.current", "tenant_id");
  return {
    lab: c.id,
    providers: ["azurerm", "azuread"],
    variables: c.variables,
    data: [
      {
        address: "data.azurerm_client_config.current",
        values: { id: `clientConfigs/clientId=${PIPELINE_CLIENT_ID};objectId=${PIPELINE_OBJECT_ID};subscriptionId=${SUB};tenantId=${TENANT}`, client_id: PIPELINE_CLIENT_ID, object_id: PIPELINE_OBJECT_ID, subscription_id: SUB, tenant_id: TENANT },
      },
    ],
    resources: [
      rgResource(c),
      { address: "azurerm_virtual_network.hub", values: { name: "vnet-hub", resource_group_name: c.rg, location: REGION, address_space: ["10.71.192.0/20"], tags: c.tags }, refs: { ...IN_RG, address_space: ["local.hub_cidr"] } },
      subnet("gateway", "GatewaySubnet", "10.71.192.0/27"),
      subnet("app", "snet-app", "10.71.193.0/24"),

      // The gateway, its zone-redundant Standard public IP and its point-to-site configuration.
      { address: "azurerm_public_ip.gateway", values: { name: "pip-vpngw-hub", resource_group_name: c.rg, location: REGION, allocation_method: "Static", sku: "Standard", zones: ["1", "2", "3"], tags: c.tags }, refs: IN_RG },
      {
        address: "azurerm_virtual_network_gateway.hub",
        values: {
          name: "vpngw-hub",
          resource_group_name: c.rg,
          location: REGION,
          type: "Vpn",
          vpn_type: "RouteBased",
          sku: "VpnGw1AZ",
          generation: "Generation1",
          active_active: false,
          bgp_enabled: false,
          tags: c.tags,
          ip_configuration: [{ name: "gwipconfig", private_ip_address_allocation: "Dynamic" }],
          vpn_client_configuration: [
            {
              address_space: ["10.71.255.0/24"],
              vpn_client_protocols: ["OpenVPN"],
              vpn_auth_types: ["AAD"],
              aad_tenant: `https://login.microsoftonline.com/${TENANT}/`,
              aad_audience: "c632b3df-fb67-4d84-bdcf-b95ad541b5c8",
              aad_issuer: `https://sts.windows.net/${TENANT}/`,
            },
          ],
        },
        unknown: ["ip_configuration.0.public_ip_address_id", "ip_configuration.0.subnet_id"],
        refs: {
          ...IN_RG,
          "ip_configuration.0.public_ip_address_id": ref("azurerm_public_ip.gateway", "id"),
          "ip_configuration.0.subnet_id": ref("azurerm_subnet.gateway", "id"),
          "vpn_client_configuration.0.address_space": ["local.p2s_pool"],
          "vpn_client_configuration.0.aad_tenant": tenant,
          "vpn_client_configuration.0.aad_issuer": tenant,
        },
      },

      // The lab user to sign in to the VPN as.
      {
        address: "azuread_user.vpnuser",
        values: {
          display_name: `lab-${c.id}-vpnuser`,
          user_principal_name: `lab-${c.id}-vpnuser@${UPN}`,
          mail_nickname: `lab-${c.id}-vpnuser`,
          password: "(the session's admin password)",
          force_password_change: false,
          usage_location: "GB",
        },
        refs: { display_name: ["var.lab_id"], user_principal_name: ["var.lab_id", "var.upn_domain"], mail_nickname: ["var.lab_id"], password: ["var.admin_password"] },
        sensitive: ["password"],
      },

      // vm-app, the thing to reach over the VPN.
      ...linuxVm(c, { name: "vm-app", key: "app", subnet: "azurerm_subnet.app", customData: "I2Nsb3VkLWNvbmZpZwo= (cloud-init.yaml.tftpl, port 80)" }),
    ],
  };
};
