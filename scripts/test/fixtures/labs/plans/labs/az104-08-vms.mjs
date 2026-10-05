// az104-08-vms.mjs: lab 8's first-deploy plan, as labs/az104-08-vms/terraform/main.tf
// builds it (two zonal VMs, a zonal data disk on the first, a Custom Script
// extension on each). Fake ids; realistic.mjs adds what Azure computes.

import { ctx, IN_RG, REGION, linuxVm, ref, rgResource } from "../common.mjs";

/** local.serve_web, as main.tf writes it (known at plan). */
const SERVE_WEB =
  "mkdir -p /srv/www && hostname > /srv/www/index.html && printf '[Unit]\\nDescription=Lab web page (the VM name) on port 80\\nAfter=network-online.target\\n\\n[Service]\\nExecStart=/usr/bin/python3 -m http.server 80 --directory /srv/www\\nRestart=always\\n\\n[Install]\\nWantedBy=multi-user.target\\n' > /etc/systemd/system/lab-web.service && systemctl daemon-reload && systemctl enable --now lab-web.service";

const extension = (c, vm) => ({
  address: `azurerm_virtual_machine_extension.web_${vm}`,
  values: {
    name: "serve-web",
    publisher: "Microsoft.Azure.Extensions",
    type: "CustomScript",
    type_handler_version: "2.1",
    auto_upgrade_minor_version: true,
    settings: JSON.stringify({ commandToExecute: SERVE_WEB }),
    tags: c.tags,
  },
  unknown: ["virtual_machine_id"],
  refs: { virtual_machine_id: ref(`azurerm_linux_virtual_machine.${vm}`, "id"), settings: ["local.serve_web"], tags: ["var.tags"] },
});

export default () => {
  const c = ctx("az104-08-vms", "08");
  return {
    lab: c.id,
    variables: c.variables,
    resources: [
      rgResource(c),
      { address: "azurerm_virtual_network.lab", values: { name: "vnet-lab", resource_group_name: c.rg, location: REGION, address_space: ["10.64.64.0/20"], tags: c.tags }, refs: { ...IN_RG, address_space: ["local.vnet_cidr"] } },
      {
        address: "azurerm_subnet.vms",
        values: { name: "snet-vms", resource_group_name: c.rg, virtual_network_name: "vnet-lab", address_prefixes: ["10.64.64.0/24"], default_outbound_access_enabled: true },
        refs: { resource_group_name: IN_RG.resource_group_name, virtual_network_name: ref("azurerm_virtual_network.lab", "name"), address_prefixes: ["local.vms_cidr"] },
      },
      ...linuxVm(c, { name: "vm-zone1", subnet: "azurerm_subnet.vms", zone: "1" }),
      ...linuxVm(c, { name: "vm-zone2", subnet: "azurerm_subnet.vms", zone: "2" }),
      {
        address: "azurerm_managed_disk.data",
        values: { name: "disk-zone1-data", resource_group_name: c.rg, location: REGION, storage_account_type: "StandardSSD_LRS", create_option: "Empty", disk_size_gb: 4, zone: "1", tags: c.tags },
        refs: IN_RG,
      },
      {
        address: "azurerm_virtual_machine_data_disk_attachment.data",
        values: { lun: 0, caching: "ReadWrite" },
        unknown: ["managed_disk_id", "virtual_machine_id"],
        refs: { managed_disk_id: ref("azurerm_managed_disk.data", "id"), virtual_machine_id: ref("azurerm_linux_virtual_machine.zone1", "id") },
      },
      extension(c, "zone1"),
      extension(c, "zone2"),
    ],
  };
};
