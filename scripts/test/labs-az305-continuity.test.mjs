// labs-az305-continuity.test.mjs
//
// Plain English: the continuity and multi-region labs (labs batch 3 plan,
// area C3: labs 26 and 27) checked without touching Azure. Each runs the
// shared content suite (fixtures/labs/content.mjs) with two resource groups,
// rg-lab-<id> in uksouth and rg-lab-<id>-secondary in ukwest, then its own
// tests: what it builds, that everything Azure makes for it lands in one of
// those two groups, and that it is priced honestly in both regions. init,
// validate and the mock plan are npm run labs-tf's job.

import { test } from "node:test";
import assert from "node:assert/strict";
import { attr, lab, labContentSuite, outputs, resources, uncomment } from "./fixtures/labs/content.mjs";

const SR = "az305-26-site-recovery";

/** The body of the first nested block `name { ... }` in `body` (any depth), or undefined. */
function nested(body, name) {
  const m = new RegExp(`(?:^|\\n)[ \\t]*${name}[ \\t]*\\{`).exec(body ?? "");
  if (!m) return undefined;
  let depth = 0;
  let i = m.index + m[0].length - 1;
  for (; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}" && --depth === 0) break;
  }
  return body.slice(m.index + m[0].length, i);
}

/** Every nested block `name { ... }` in `body`. */
function allNested(body, name) {
  const out = [];
  let rest = body ?? "";
  for (let b = nested(rest, name); b !== undefined; b = nested(rest, name)) {
    out.push(b);
    rest = rest.slice(rest.indexOf(b) + b.length);
  }
  return out;
}

/** `body` with every nested block's contents taken out (`name {}` stays), so attr() reads only top-level arguments. */
function topLevel(body) {
  let out = "";
  let depth = 0;
  for (const ch of body ?? "") {
    if (ch === "{" && depth++ > 0) continue;
    if (ch === "}" && --depth > 0) continue;
    if (depth === 0 || ch === "{") out += ch;
  }
  return out;
}
const top = (body, name) => attr(topLevel(body), name);

/** A list literal's quoted strings: ["a", "b"] -> ["a", "b"]. */
const strings = (v) => [...(v ?? "").matchAll(/"([^"]*)"/g)].map((m) => m[1]);

const one = (l, type) => {
  const rs = resources(l, type);
  assert.equal(rs.length, 1, `exactly one ${type}`);
  return rs[0];
};
const byName = (l, type, name) => {
  const r = resources(l, type).find((x) => x.labels[1] === name);
  assert.ok(r, `${type}.${name} exists`);
  return r;
};

/** The azurerm provider's features block from versions.tf. */
const features = (l) => {
  const p = l.blocks.find((b) => b.kind === "provider" && b.labels[0] === "azurerm");
  assert.ok(p, 'versions.tf has provider "azurerm"');
  const f = nested(p.body, "features");
  assert.ok(f !== undefined, "the azurerm provider has a features block");
  return f;
};

/** The lab's locals, name -> expression (one per line, as terraform fmt lays them out). */
function locals(l) {
  const out = {};
  for (const b of l.blocks.filter((x) => x.kind === "locals")) for (const m of b.body.matchAll(/^\s*([a-z0-9_]+)\s*=\s*(.+)$/gm)) out[m[1]] = m[2].trim();
  return out;
}
/** An expression with local.x replaced by its value, until none is left. */
function expand(l, expr) {
  const ls = locals(l);
  let e = expr ?? "";
  for (let i = 0; i < 8 && /\blocal\.[a-z0-9_]+/.test(e); i++) e = e.replace(/\blocal\.([a-z0-9_]+)/g, (m, n) => ls[n] ?? m);
  return e;
}
/** A VNet's or subnet's only address, from `address_space` / `address_prefixes` = [x], locals expanded. */
function cidrOf(l, body, name) {
  const v = attr(body, name);
  const m = /^\[(.+)\]$/.exec(v ?? "");
  assert.ok(m, `${name} is a one-element list (${v})`);
  return expand(l, m[1]).replace(/\s+/g, " ");
}

const IN_LAB = "azurerm_resource_group.lab.name";
const IN_SECONDARY = "azurerm_resource_group.secondary.name";

// ── Lab 26: Site Recovery ────────────────────────────────────────────────

labContentSuite(SR, { marker: "££", secondary: true });

test(`${SR}: one Ubuntu 22.04 Standard_B1s source VM with no public IP and default outbound on`, () => {
  const l = lab(SR);
  const vm = one(l, "azurerm_linux_virtual_machine");
  assert.equal(attr(vm.body, "resource_group_name"), IN_LAB, "the source VM is in rg-lab-<id>, in the session's region");
  assert.equal(attr(vm.body, "location"), "azurerm_resource_group.lab.location");
  assert.equal(attr(vm.body, "size"), '"Standard_B1s"');
  const image = nested(vm.body, "source_image_reference");
  // Ubuntu 22.04 Gen2: a kernel series Site Recovery's Azure-to-Azure support matrix lists (ruling 32).
  assert.deepEqual([attr(image, "publisher"), attr(image, "offer"), attr(image, "sku")], ['"Canonical"', '"0001-com-ubuntu-server-jammy"', '"22_04-lts-gen2"']);
  // The standard security type: no Trusted Launch settings of its own.
  for (const a of ["secure_boot_enabled", "vtpm_enabled", "encryption_at_host_enabled"]) assert.equal(attr(vm.body, a), undefined, `${a} is not set`);
  // Its one NIC has no public IP; nothing in the lab has one.
  assert.equal(resources(l, "azurerm_public_ip").length, 0, "no azurerm_public_ip");
  const nic = one(l, "azurerm_network_interface");
  assert.equal(attr(vm.body, "network_interface_ids"), `[azurerm_network_interface.${nic.labels[1]}.id]`);
  assert.doesNotMatch(nic.body, /public_ip_address_id/);
  // Ruling 37: its subnet sets default outbound access on, so the Mobility agent reaches Site Recovery.
  const subnetName = /^azurerm_subnet\.([A-Za-z0-9_-]+)\.id$/.exec(attr(nested(nic.body, "ip_configuration"), "subnet_id") ?? "")?.[1];
  const subnet = byName(l, "azurerm_subnet", subnetName);
  assert.equal(attr(subnet.body, "resource_group_name"), IN_LAB);
  assert.equal(attr(subnet.body, "default_outbound_access_enabled"), "true");
  // It serves its name and region on port 80 (cloud-init, python3 -m http.server).
  assert.match(attr(vm.body, "custom_data") ?? "", /templatefile\("\$\{path\.module\}\/cloud-init\.yaml\.tftpl"/);
  // The VM's VNet is the one the pipeline peers to the gateway.
  const vnet = /^azurerm_virtual_network\.([A-Za-z0-9_-]+)\.name$/.exec(attr(subnet.body, "virtual_network_name") ?? "")?.[1];
  assert.equal(l.blocks.find((b) => b.kind === "output" && b.labels[0] === "peer_vnet_id")?.body.trim(), `value = azurerm_virtual_network.${vnet}.id`);
});

test(`${SR}: the vault and the target and test VNets are in rg-lab-<id>-secondary, the VNets from /20s 1 and 2`, () => {
  const l = lab(SR);
  const vault = one(l, "azurerm_recovery_services_vault");
  assert.equal(attr(vault.body, "resource_group_name"), IN_SECONDARY);
  assert.equal(attr(vault.body, "location"), "azurerm_resource_group.secondary.location", "the vault is in the target region, as Azure-to-Azure Site Recovery needs");
  const vnets = Object.fromEntries(resources(l, "azurerm_virtual_network").map((v) => [v.labels[1], v.body]));
  assert.deepEqual(Object.keys(vnets).sort(), ["source", "target", "test"], "vnet-source, vnet-target and vnet-test");
  const want = { source: [IN_LAB, 0], target: [IN_SECONDARY, 1], test: [IN_SECONDARY, 2] };
  for (const [k, [rg, n]] of Object.entries(want)) {
    assert.equal(attr(vnets[k], "resource_group_name"), rg, `vnet-${k}'s group`);
    assert.equal(attr(vnets[k], "name"), `"vnet-${k}"`);
    assert.equal(cidrOf(l, vnets[k], "address_space"), `cidrsubnet(var.address_space, 2, ${n})`, `vnet-${k} is /20 ${n} of the slot`);
    // One subnet each, cut from its own VNet's /20, all named alike so a failover keeps the subnet's name.
    const subnets = resources(l, "azurerm_subnet").filter((s) => attr(s.body, "virtual_network_name") === `azurerm_virtual_network.${k}.name`);
    assert.equal(subnets.length, 1, `one subnet in vnet-${k}`);
    assert.equal(attr(subnets[0].body, "resource_group_name"), rg);
    assert.equal(attr(subnets[0].body, "name"), '"snet-vms"');
    assert.ok(cidrOf(l, subnets[0].body, "address_prefixes").startsWith(`cidrsubnet(cidrsubnet(var.address_space, 2, ${n}), `), `vnet-${k}'s subnet is inside its /20`);
    assert.equal(attr(subnets[0].body, "default_outbound_access_enabled"), "true", "ruling 37, in every region");
  }
});

test(`${SR}: the replicated VM's target group, disks' target group and networks are the lab's own`, () => {
  const l = lab(SR);
  const vm = one(l, "azurerm_linux_virtual_machine");
  const vmAddr = `azurerm_linux_virtual_machine.${vm.labels[1]}`;
  const vault = one(l, "azurerm_recovery_services_vault");
  const rep = one(l, "azurerm_site_recovery_replicated_vm").body;
  assert.equal(top(rep, "source_vm_id"), `${vmAddr}.id`);
  assert.equal(top(rep, "recovery_vault_name"), `azurerm_recovery_services_vault.${vault.labels[1]}.name`);
  assert.equal(top(rep, "target_resource_group_id"), "azurerm_resource_group.secondary.id", "the failover VM lands in rg-lab-<id>-secondary");
  assert.equal(top(rep, "target_network_id"), "azurerm_virtual_network.target.id");
  assert.equal(top(rep, "test_network_id"), "azurerm_virtual_network.test.id");
  // Fabrics, containers and the policy are the lab's own (source in the region, target in the secondary region).
  assert.equal(top(rep, "source_recovery_fabric_name"), "azurerm_site_recovery_fabric.source.name");
  assert.equal(top(rep, "source_recovery_protection_container_name"), "azurerm_site_recovery_protection_container.source.name");
  assert.equal(top(rep, "target_recovery_fabric_id"), "azurerm_site_recovery_fabric.target.id");
  assert.equal(top(rep, "target_recovery_protection_container_id"), "azurerm_site_recovery_protection_container.target.id");
  const policy = one(l, "azurerm_site_recovery_replication_policy");
  assert.equal(top(rep, "recovery_replication_policy_id"), `azurerm_site_recovery_replication_policy.${policy.labels[1]}.id`);
  assert.equal(attr(byName(l, "azurerm_site_recovery_fabric", "source").body, "location"), "azurerm_resource_group.lab.location");
  assert.equal(attr(byName(l, "azurerm_site_recovery_fabric", "target").body, "location"), "azurerm_resource_group.secondary.location");
  // The OS disk: replicated through the cache account in the source region, into the secondary group, as Standard HDD.
  const disks = allNested(rep, "managed_disk");
  assert.equal(disks.length, 1, "one managed_disk: the OS disk");
  assert.equal(attr(disks[0], "disk_id"), `${vmAddr}.os_disk[0].id`);
  assert.equal(attr(disks[0], "target_resource_group_id"), "azurerm_resource_group.secondary.id", "the replica disk lands in rg-lab-<id>-secondary");
  const cache = one(l, "azurerm_storage_account");
  assert.equal(attr(disks[0], "staging_storage_account_id"), `azurerm_storage_account.${cache.labels[1]}.id`);
  assert.equal(attr(cache.body, "resource_group_name"), IN_LAB, "the cache account is in the source region");
  assert.equal(attr(disks[0], "target_disk_type"), '"Standard_LRS"');
  assert.equal(attr(disks[0], "target_replica_disk_type"), '"Standard_LRS"');
  // The NIC fails over into vnet-target and tests into vnet-test, with no public IP.
  const nic = nested(rep, "network_interface");
  assert.equal(attr(nic, "source_network_interface_id"), `azurerm_network_interface.${one(l, "azurerm_network_interface").labels[1]}.id`);
  assert.equal(attr(nic, "target_subnet_name"), "azurerm_subnet.target.name");
  assert.equal(attr(nic, "failover_test_subnet_name"), "azurerm_subnet.test.name");
  assert.doesNotMatch(rep, /public_ip_address_id/);
  // Replication starts once the container and network mappings exist.
  assert.match(rep.replace(/\s+/g, " "), /depends_on = \[ ?azurerm_site_recovery_protection_container_mapping\.[a-z0-9_]+, azurerm_site_recovery_network_mapping\.[a-z0-9_]+,? ?\]/);
  // The network mapping pairs vnet-source with vnet-target.
  const nm = one(l, "azurerm_site_recovery_network_mapping").body;
  assert.equal(attr(nm, "source_network_id"), "azurerm_virtual_network.source.id");
  assert.equal(attr(nm, "target_network_id"), "azurerm_virtual_network.target.id");
  assert.equal(attr(nm, "source_recovery_fabric_name"), "azurerm_site_recovery_fabric.source.name");
  assert.equal(attr(nm, "target_recovery_fabric_name"), "azurerm_site_recovery_fabric.target.name");
});

test(`${SR}: everything Site Recovery makes is in rg-lab-<id>-secondary`, () => {
  const l = lab(SR);
  // The vault and every Site Recovery object in it live in the secondary group.
  const asr = resources(l).filter((r) => r.labels[0].startsWith("azurerm_site_recovery_") || r.labels[0] === "azurerm_recovery_services_vault");
  assert.equal(asr.length, 9, "vault, 2 fabrics, 2 containers, policy, container mapping, network mapping, replicated VM");
  for (const r of asr) assert.equal(top(r.body, "resource_group_name"), IN_SECONDARY, r.labels.join("."));
  // The replicated VM sets nothing that could put a failover VM, disk, IP or diagnostics account anywhere else.
  const rep = one(l, "azurerm_site_recovery_replicated_vm").body;
  const allowed = [
    "name", "resource_group_name", "recovery_vault_name", "source_recovery_fabric_name", "source_vm_id", "recovery_replication_policy_id",
    "source_recovery_protection_container_name", "target_resource_group_id", "target_recovery_fabric_id", "target_recovery_protection_container_id",
    "target_network_id", "test_network_id", "target_virtual_machine_size", "depends_on",
  ];
  const set = [...topLevel(rep).matchAll(/^\s*([a-z0-9_]+)\s*=/gm)].map((m) => m[1]);
  assert.deepEqual(set.filter((a) => !allowed.includes(a)), [], "only the lab's own targets");
  const blocks = [...topLevel(rep).matchAll(/^\s*([a-z0-9_]+)\s*\{/gm)].map((m) => m[1]).sort();
  assert.deepEqual(blocks, ["managed_disk", "network_interface"], "no unmanaged_disk");
  assert.deepEqual([...nested(rep, "managed_disk").matchAll(/^\s*([a-z0-9_]+)\s*=/gm)].map((m) => m[1]).sort(), ["disk_id", "staging_storage_account_id", "target_disk_type", "target_replica_disk_type", "target_resource_group_id"]);
  assert.deepEqual([...nested(rep, "network_interface").matchAll(/^\s*([a-z0-9_]+)\s*=/gm)].map((m) => m[1]).sort(), ["failover_test_subnet_name", "source_network_interface_id", "target_subnet_name"]);
  // No automation account (the agent's auto-update would make one), no recovery plan or extra groups.
  assert.equal(resources(l, "azurerm_automation_account").length, 0);
  assert.deepEqual(resources(l, "azurerm_resource_group").map((r) => r.labels[1]).sort(), ["lab", "secondary"]);
});

test(`${SR}: the container mapping does not auto-update the agent (no automation account)`, () => {
  const l = lab(SR);
  const m = one(l, "azurerm_site_recovery_protection_container_mapping").body;
  const au = nested(m, "automatic_update");
  assert.ok(au !== undefined, "automatic_update is written out, so the choice is visible");
  assert.equal(attr(au, "enabled"), "false");
  assert.equal(attr(au, "automation_account_id"), undefined);
  assert.equal(attr(m, "recovery_fabric_name"), "azurerm_site_recovery_fabric.source.name");
  assert.equal(attr(m, "recovery_source_protection_container_name"), "azurerm_site_recovery_protection_container.source.name");
  assert.equal(attr(m, "recovery_target_protection_container_id"), "azurerm_site_recovery_protection_container.target.id");
  const policy = one(l, "azurerm_site_recovery_replication_policy");
  assert.equal(attr(m, "recovery_replication_policy_id"), `azurerm_site_recovery_replication_policy.${policy.labels[1]}.id`);
});

test(`${SR}: a replication policy keeping 6 hours of recovery points, with no app-consistent snapshots`, () => {
  const p = one(lab(SR), "azurerm_site_recovery_replication_policy").body;
  assert.equal(attr(p, "recovery_point_retention_in_minutes"), "360");
  assert.equal(attr(p, "application_consistent_snapshot_frequency_in_minutes"), "0", "crash-consistent points only: no app-consistent snapshot work on a B1s");
});

test(`${SR}: a Standard LRS vault with soft delete on (not always-on) and immutability Disabled`, () => {
  const l = lab(SR);
  const v = one(l, "azurerm_recovery_services_vault").body;
  assert.equal(attr(v, "sku"), '"Standard"');
  assert.equal(attr(v, "storage_mode_type"), '"LocallyRedundant"');
  assert.equal(attr(v, "cross_region_restore_enabled"), "false");
  // azurerm refuses a new vault with soft delete off; unblock turns it off before tear-down (lab 19's path).
  assert.equal(attr(v, "soft_delete_enabled"), "true");
  assert.doesNotMatch(v, /AlwaysOn/i);
  assert.equal(attr(v, "immutability"), '"Disabled"');
  // A VM someone backs up into this vault by hand (the failed-over one, in ukwest) is purged with it.
  assert.equal(attr(nested(features(l), "recovery_service"), "purge_protected_items_from_vault_on_destroy"), "true");
  assert.equal(attr(nested(features(l), "resource_group"), "prevent_deletion_if_contains_resources"), "false");
});

test(`${SR}: the cache account is StorageV2 LRS in the source region, with shared keys on and no blob soft delete`, () => {
  const sa = one(lab(SR), "azurerm_storage_account").body;
  assert.equal(attr(sa, "name"), '"${var.name_prefix}cache"');
  assert.equal(attr(sa, "location"), "azurerm_resource_group.lab.location");
  assert.equal(attr(sa, "account_kind"), '"StorageV2"');
  assert.equal(attr(sa, "account_tier"), '"Standard"');
  assert.equal(attr(sa, "account_replication_type"), '"LRS"');
  assert.equal(attr(sa, "shared_access_key_enabled"), "true", "Site Recovery writes to the cache with the account's keys");
  assert.equal(attr(sa, "allow_nested_items_to_be_public"), "false");
  // Site Recovery does not support soft delete on a cache account.
  assert.equal(nested(sa, "blob_properties"), undefined, "no blob_properties: no soft delete, no versioning");
});

test(`${SR}: vm_sizes lists two Standard_B1s and the replica disk is priced in the secondary region`, () => {
  const l = lab(SR);
  const y = l.yaml;
  assert.deepEqual(y.capacity.vm_sizes, ["Standard_B1s", "Standard_B1s"], "the source VM and its failover (or test failover) VM");
  // The failover VM is the source VM's size.
  const vm = one(l, "azurerm_linux_virtual_machine");
  assert.equal(top(one(l, "azurerm_site_recovery_replicated_vm").body, "target_virtual_machine_size"), attr(vm.body, "size"));
  const secondary = (pick) => y.cost.items.filter((i) => i.region === "secondary" && pick(i));
  assert.equal(secondary((i) => i.retail?.meter === "S4 LRS Disk" && i.retail.unit === "1/Month").length, 1, "the replica disk, an S4, in ukwest");
  assert.equal(secondary((i) => i.retail?.sku === "Standard_B1s").length, 1, "the test failover VM, a B1s, in ukwest");
  // Site Recovery's per-instance fee, from the price feed, where the vault is.
  const asr = y.cost.items.filter((i) => i.retail?.meter === "VM Replicated to Azure");
  assert.equal(asr.length, 1, "a VM Replicated to Azure item");
  assert.equal(asr[0].retail.unit, "1/Month");
  assert.equal(asr[0].region, "secondary", "billed with the vault, in ukwest");
  assert.equal(asr[0].qty ?? 1, 1);
  // The initial copy crosses regions: inter-region transfer is priced (authored: per GB).
  const transfer = y.cost.items.find((i) => /inter-region/i.test(i.name));
  assert.ok(transfer, "an inter-region transfer item");
  assert.equal(transfer.retail, undefined);
});

test(`${SR}: deploy allows for the initial replication, destroy for disabling it, and the job timeout is 110`, () => {
  const { timing, prerequisites, regions, connectivity } = lab(SR).yaml;
  assert.deepEqual(timing, { deploy_min: 25, destroy_min: 20, session_h: 3, max_h: 8 });
  assert.equal(Math.min(150, 2 * (timing.deploy_min + timing.destroy_min) + 20), 110);
  assert.deepEqual(prerequisites, ["az104-08-vms"]);
  assert.deepEqual(regions, { secondary: "ukwest" });
  assert.deepEqual(connectivity, { peering: "optional", dns_link: false, subnets_used: 3 });
});

test(`${SR}: the readme says never to re-protect into another group`, () => {
  const r = lab(SR).readme;
  assert.match(r, /[Nn]ever re-?protect[^\n]*another (resource )?group/);
  assert.match(r, /uksouth[^\n]*ukwest[^\n]*pair/, "the lab must be deployed in uksouth with ukwest as its pair");
  assert.match(r, /`rg-lab-az305-26-site-recovery-secondary`/, "names the secondary group and what it holds");
  assert.match(r, /31 days/, "the per-instance fee's free first 31 days");
  assert.match(r, /test failover/i);
  assert.match(r, /serial console/i, "after a failover the VM is reached through the serial console, not the tunnel");
  const tries = r.split("## Things to try")[1].split("## Learn more")[0];
  assert.match(tries, /[Cc]lean up test failover/);
  assert.match(tries, /recovery plan/i);
});

test(`${SR}: no literal subscription ids or other groups in the Terraform`, () => {
  const all = uncomment(Object.values(lab(SR).files).join("\n"));
  assert.doesNotMatch(all, /\/subscriptions\//);
  assert.doesNotMatch(all, /resourceGroups\//i);
  assert.ok(outputs(lab(SR)).includes("peer_vnet_id"));
});
