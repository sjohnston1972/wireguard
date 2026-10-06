// scripts/test/fixtures/labs/plans/common.mjs
//
// Plain English: the parts every lab's plan fixture shares (labs.mjs for labs
// 1-7, one file per lab in labs/ for batch 2): the values a real session
// gives (slot 1, uksouth, a name prefix, a UPN domain, the tags), the
// references most resources make to the lab's resource group, and a Linux VM
// with its NIC shaped as lab 7 builds one. Fake ids only.
//
// A batch 2 file, labs/<id>.mjs, looks like:
//
//   import { ctx, rgResource, IN_RG, ref, linuxVm } from "../common.mjs";
//   export default () => {
//     const c = ctx("az104-08-vms", "08");
//     return { lab: c.id, variables: c.variables, resources: [rgResource(c), ...] };
//   };

export const SUB = "3f2b7c1e-5a4d-4e8f-9b6a-2c1d0e9f8a7b";
export const TENANT = "8c7d6e5f-4a3b-4c2d-9e1f-0a9b8c7d6e5f";
export const UPN = "wgadminlabs.onmicrosoft.com";
export const REGION = "uksouth";
/** The secondary region every batch 3 lab with regions.secondary names (uksouth's pair). */
export const SECONDARY = "ukwest";
/** Slot 1, as lab.yml passes it in address_space. */
export const SLOT = "10.64.64.0/18";
export const SSH_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeFakeFakeFakeFakeFakeFakeFakeFakeFake wg-admin";

/**
 * A session's values for lab `id` (number `n`, two digits): rg, rgSecondary
 * (rg-lab-<id>-secondary), prefix (l<n>k3x9q), tags and the pipeline's
 * variables (secondary_region ukwest, as a lab with regions.secondary gets it).
 */
export const ctx = (id, n) => {
  const rg = `rg-lab-${id}`;
  const prefix = `l${n}k3x9q`;
  const tags = { project: "wg-admin-labs", lab: id, session: "ls-20261005T0900-ab12" };
  return {
    id,
    rg,
    rgSecondary: `${rg}-secondary`,
    prefix,
    tags,
    variables: { lab_id: id, name_prefix: prefix, resource_group_name: rg, region: REGION, secondary_region: SECONDARY, address_space: SLOT, peered: false, gateway_vnet_id: "", upn_domain: UPN, tags },
  };
};

/** The lab's own group's references: name, location and tags from the pipeline. */
export const RG_REFS = { name: ["var.resource_group_name"], location: ["var.region"], tags: ["var.tags"] };
/** A resource inside the lab's group: resource_group_name and location from azurerm_resource_group.lab, tags from var.tags. */
export const IN_RG = { resource_group_name: ["azurerm_resource_group.lab.name", "azurerm_resource_group.lab"], location: ["azurerm_resource_group.lab.location", "azurerm_resource_group.lab"], tags: ["var.tags"] };
/** References to one attribute of a resource, as Terraform lists them: ["azurerm_x.y.attr", "azurerm_x.y"]. */
export const ref = (address, attr) => [`${address}.${attr}`, address];

/** azurerm_resource_group.lab, as every lab makes it. */
export const rgResource = (c) => ({ address: "azurerm_resource_group.lab", values: { name: c.rg, location: REGION, tags: c.tags }, refs: RG_REFS });

/** azurerm_resource_group.secondary, as a lab with regions.secondary makes it: "${var.resource_group_name}-secondary" in var.secondary_region. */
export const rgSecondaryResource = (c) => ({
  address: "azurerm_resource_group.secondary",
  values: { name: c.rgSecondary, location: SECONDARY, tags: c.tags },
  refs: { name: ["var.resource_group_name"], location: ["var.secondary_region"], tags: ["var.tags"] },
});

/**
 * A Linux VM and its NIC, as lab 7 builds them: no public IP, Ubuntu 24.04,
 * a Standard_LRS OS disk, boot diagnostics (serial console), the session's
 * password and the operator's SSH key (a dynamic block: planned, but with no
 * expressions in the configuration, as the real labs 22 and 26 recorded it).
 *
 *   name        the VM's name (vm-web); the NIC is nic-<name>
 *   key         the resource name in main.tf (default: name without "vm-", "-" as "_")
 *   subnet      the subnet's address (azurerm_subnet.web); its id is unknown at plan
 *   size        default Standard_B1s
 *   zone        "1", "2" or "3" (zone attribute), or left out
 *   customData  a string: known at plan (templatefile of known values, base64);
 *               an array of references: unknown at plan (built from apply-time values)
 *   identity    "SystemAssigned" for a system-assigned identity, or left out
 *   image       { publisher?, offer, sku, version? } (default Canonical
 *               Ubuntu 24.04, ubuntu-24_04-lts / server, at "latest"; lab 26
 *               uses AlmaLinux 9.7 Gen2, pinned to one version)
 *
 * Returns [nic, vm]: azurerm_network_interface.<key> and azurerm_linux_virtual_machine.<key>.
 */
export function linuxVm(c, { name, key = name.replace(/^vm-/, "").replace(/-/g, "_"), subnet, size = "Standard_B1s", zone, customData, identity, image = { offer: "ubuntu-24_04-lts", sku: "server" } }) {
  const nicAddress = `azurerm_network_interface.${key}`;
  const nic = {
    address: nicAddress,
    values: { name: `nic-${name}`, resource_group_name: c.rg, location: REGION, tags: c.tags, ip_configuration: [{ name: "ipconfig1", subnet_id: "(unknown)", private_ip_address_allocation: "Dynamic" }] },
    unknown: ["ip_configuration.0.subnet_id"],
    refs: { ...IN_RG, "ip_configuration.0.subnet_id": ref(subnet, "id") },
  };
  const values = {
    name,
    resource_group_name: c.rg,
    location: REGION,
    size,
    admin_username: "azureuser",
    admin_password: "(the session's admin password)",
    disable_password_authentication: false,
    tags: c.tags,
    admin_ssh_key: [{ username: "azureuser", public_key: SSH_KEY }],
    os_disk: [{ caching: "ReadWrite", storage_account_type: "Standard_LRS" }],
    source_image_reference: [{ publisher: image.publisher ?? "Canonical", offer: image.offer, sku: image.sku, version: image.version ?? "latest" }],
    boot_diagnostics: [{}],
  };
  if (zone !== undefined) values.zone = String(zone);
  if (identity) values.identity = [{ type: identity }];
  const unknown = ["network_interface_ids"];
  const refs = { ...IN_RG, admin_password: ["var.admin_password"], network_interface_ids: ref(nicAddress, "id") };
  const sensitive = ["admin_password"];
  if (typeof customData === "string") {
    values.custom_data = customData;
    refs.custom_data = ["path.module"];
    sensitive.push("custom_data");
  } else if (Array.isArray(customData)) {
    unknown.push("custom_data");
    refs.custom_data = ["path.module", ...customData];
    sensitive.push("custom_data");
  }
  return [nic, { address: `azurerm_linux_virtual_machine.${key}`, values, unknown, refs, sensitive, dynamic: ["admin_ssh_key"] }];
}
