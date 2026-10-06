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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { attr, lab, labContentSuite, outputs, resources, uncomment } from "./fixtures/labs/content.mjs";

const SR = "az305-26-site-recovery";
const MR = "az305-27-multi-region";

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

labContentSuite(SR, { marker: "£££", secondary: true });

test(`${SR}: one AlmaLinux 9.7 Standard_B1s source VM, its image pinned, with no public IP and default outbound on`, () => {
  const l = lab(SR);
  const vm = one(l, "azurerm_linux_virtual_machine");
  assert.equal(attr(vm.body, "resource_group_name"), IN_LAB, "the source VM is in rg-lab-<id>, in the session's region");
  assert.equal(attr(vm.body, "location"), "azurerm_resource_group.lab.location");
  assert.equal(attr(vm.body, "size"), '"Standard_B1s"');
  const image = nested(vm.body, "source_image_reference");
  // Ruling 32: AlmaLinux 9.7 Gen2, pinned to one image version. Site Recovery's Mobility agent
  // supports a fixed list of kernels; Ubuntu 22.04's current Azure kernel (6.8.0-1064) was past
  // it (agent 9.66, release test 2026-10-06). 9.7's kernel is on the list; a 9.8 image needs
  // agent 9.67, so never "latest".
  assert.deepEqual(
    [attr(image, "publisher"), attr(image, "offer"), attr(image, "sku"), attr(image, "version")],
    ['"almalinux"', '"almalinux-x86_64"', '"9-gen2"', '"9.7.2026051801"'],
  );
  // A free image: no marketplace plan, so no terms to accept.
  assert.equal(nested(vm.body, "plan"), undefined, "no plan block");
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

test(`${SR}: cloud-init serves "vm-app in <region>" on port 80 on AlmaLinux and never touches the kernel`, () => {
  const l = lab(SR);
  const vm = one(l, "azurerm_linux_virtual_machine");
  assert.equal(attr(vm.body, "custom_data"), 'base64encode(templatefile("${path.module}/cloud-init.yaml.tftpl", { port = 80 }))');
  const tpl = readFileSync(join(l.tfDir, "cloud-init.yaml.tftpl"), "utf8").replace(/\r\n/g, "\n");
  // Terraform's templatefile fills ${port}; shell variables are written $name, never ${name}.
  const rendered = tpl.replace(/\$\{(\w+)\}/g, (_, k) => {
    assert.equal(k, "port", `the template takes only port (found \${${k}})`);
    return "80";
  });
  assert.doesNotMatch(rendered, /%\{/, "no template directives");
  assert.match(tpl, /^#cloud-config\n/);
  const doc = parseYaml(rendered);
  // Nothing installed or upgraded: a newer kernel could be one the Mobility agent does not support.
  assert.equal(doc.packages, undefined, "no packages");
  assert.equal(doc.package_update, false, "package_update: false");
  assert.equal(doc.package_upgrade, false, "package_upgrade: false");
  assert.equal(doc.package_reboot_if_required, false, "package_reboot_if_required: false");
  const all = rendered.replace(/^\s*#.*$/gm, "");
  assert.doesNotMatch(all, /\b(apt|apt-get|yum|dnf|rpm|pip|snap|wget)\b/, "no package manager, no downloads");
  // The page: the VM's name and the region the instance metadata service reports, written each time the service starts.
  const index = doc.write_files.find((f) => f.path === "/usr/local/bin/lab-index");
  assert.ok(index, "/usr/local/bin/lab-index");
  assert.equal(index.permissions, "0755");
  assert.match(index.content, /169\.254\.169\.254\/metadata\/instance\/compute\/location/);
  assert.match(index.content, /> \/srv\/lab\/index\.html/);
  assert.doesNotMatch(index.content, /\bhostname\b/, "uname -n: the hostname command is not on every image");
  const unit = doc.write_files.find((f) => f.path === "/etc/systemd/system/lab-http.service");
  assert.ok(unit, "a systemd unit lab-http.service");
  // A systemd service runs unconfined under SELinux (enforcing on AlmaLinux) and may bind port 80.
  assert.match(unit.content, /^ExecStartPre=\/usr\/local\/bin\/lab-index$/m);
  assert.match(unit.content, /^ExecStart=\/usr\/bin\/python3 -m http\.server 80 --directory \/srv\/lab$/m);
  assert.match(unit.content, /^Restart=always$/m);
  assert.match(unit.content, /^WantedBy=multi-user\.target$/m);
  // firewalld, where the image runs it, lets port 80 in (permanently, so a failed-over copy answers too).
  const cmds = doc.runcmd.map((c) => (Array.isArray(c) ? c.join(" ") : c));
  const fw = cmds.find((c) => /firewall-cmd/.test(c));
  assert.ok(fw, "a runcmd opens port 80 in firewalld");
  assert.match(fw, /systemctl is-active --quiet firewalld/, "only when firewalld is running");
  assert.match(fw, /firewall-cmd --permanent --add-port=80\/tcp/);
  assert.match(fw, /firewall-cmd --reload/);
  assert.ok(cmds.includes("systemctl enable --now lab-http.service"));
  assert.ok(cmds.indexOf(fw) < cmds.indexOf("systemctl enable --now lab-http.service"), "the port is open before the server starts");
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

test(`${SR}: deploy allows for the initial replication, destroy for disabling it, and the job timeout is 140`, () => {
  // azurerm's replicated-VM create waits for the initial replication, so the
  // first release test gets 40 minutes (job timeout 140); the measured time
  // replaces it afterwards. A deploy of 30 or more makes the lab £££.
  const { timing, prerequisites, regions, connectivity, version } = lab(SR).yaml;
  assert.deepEqual(timing, { deploy_min: 40, destroy_min: 20, session_h: 3, max_h: 8 });
  assert.equal(Math.min(150, 2 * (timing.deploy_min + timing.destroy_min) + 20), 140);
  assert.ok(version >= 3, "the timing change (v2) and the switch to AlmaLinux (v3) each bump the version");
  assert.match(lab(SR).readme, /about 40 minutes/, "the readme gives the deploy time");
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

test(`${SR}: the readme says why the VM runs AlmaLinux, pinned, and makes the kernel lesson a design point`, () => {
  const r = lab(SR).readme;
  assert.doesNotMatch(r, /Ubuntu 22\.04 VM|Ubuntu 22\.04\)/, "the VM is no longer Ubuntu");
  assert.match(r, /AlmaLinux 9\.7/);
  assert.match(r, /9\.7\.2026051801/, "the pinned image version");
  assert.match(r, /support matrix/i, "the Mobility agent's supported kernels");
  assert.match(r, /kernel/i);
  const tries = r.split("## Things to try")[1].split("## Learn more")[0];
  assert.match(tries, /kernel/i, "a thing to try: the supported-kernel lesson as a design point");
});

test(`${SR}: no literal subscription ids or other groups in the Terraform`, () => {
  const all = uncomment(Object.values(lab(SR).files).join("\n"));
  assert.doesNotMatch(all, /\/subscriptions\//);
  assert.doesNotMatch(all, /resourceGroups\//i);
  assert.ok(outputs(lab(SR)).includes("peer_vnet_id"));
});

// ── Lab 27: multi-region front ends ──────────────────────────────────────

labContentSuite(MR, { marker: "££", secondary: true });

/** The lab's two container groups, by where they run: { uks, ukw }. */
function aciByRegion(l) {
  const groups = resources(l, "azurerm_container_group");
  assert.equal(groups.length, 2, "two container groups");
  const uks = groups.find((g) => attr(g.body, "resource_group_name") === IN_LAB);
  const ukw = groups.find((g) => attr(g.body, "resource_group_name") === IN_SECONDARY);
  assert.ok(uks && ukw, "one in rg-lab-<id> (uksouth) and one in rg-lab-<id>-secondary (ukwest)");
  return { uks, ukw };
}

test(`${MR}: one container group per region, public with a DNS label, serving the region's name`, () => {
  const l = lab(MR);
  const { uks, ukw } = aciByRegion(l);
  for (const [g, name, region, location] of [
    [uks, "ci-uks", "var.region", "azurerm_resource_group.lab.location"],
    [ukw, "ci-ukw", "var.secondary_region", "azurerm_resource_group.secondary.location"],
  ]) {
    const b = g.body;
    assert.equal(attr(b, "name"), `"${name}"`);
    assert.equal(attr(b, "location"), location);
    assert.equal(attr(b, "os_type"), '"Linux"');
    // Ruling 23: public by nature, as Traffic Manager and Front Door reach origins over the internet.
    assert.equal(attr(b, "ip_address_type"), '"Public"');
    assert.equal(attr(b, "dns_name_label"), `"\${var.name_prefix}-${name.slice(3)}"`);
    assert.equal(attr(b, "subnet_ids"), undefined, "in no VNet");
    const containers = allNested(b, "container");
    assert.equal(containers.length, 1, `${name}: one container`);
    const c = containers[0];
    assert.equal(attr(c, "image"), '"mcr.microsoft.com/azurelinux/base/python:3.12"', "an MCR image: no registry");
    assert.equal(attr(c, "cpu"), "0.5");
    assert.equal(attr(c, "memory"), "0.5");
    const cmd = attr(c, "commands") ?? "";
    assert.ok(cmd.includes(`\${${region}}`), `${name}'s page names its region (${region})`);
    assert.match(cmd, /python3 -m http\.server 80\b/);
    assert.equal(attr(nested(c, "ports"), "port"), "80");
    assert.equal(attr(nested(c, "ports"), "protocol"), '"TCP"');
  }
});

test(`${MR}: Traffic Manager priority routing over the two external endpoints`, () => {
  const l = lab(MR);
  const tm = one(l, "azurerm_traffic_manager_profile");
  assert.equal(attr(tm.body, "resource_group_name"), IN_LAB, "global, kept in rg-lab-<id>");
  assert.equal(attr(tm.body, "name"), '"${var.name_prefix}-tm"');
  assert.equal(attr(tm.body, "traffic_routing_method"), '"Priority"');
  const dns = nested(tm.body, "dns_config");
  assert.equal(attr(dns, "relative_name"), '"${var.name_prefix}-tm"');
  assert.equal(attr(dns, "ttl"), "30");
  const mon = nested(tm.body, "monitor_config");
  assert.deepEqual([attr(mon, "protocol"), attr(mon, "port"), attr(mon, "path")], ['"HTTP"', "80", '"/"']);
  assert.equal(attr(mon, "interval_in_seconds"), "30");
  assert.equal(attr(mon, "tolerated_number_of_failures"), "3", "about 90 s from failure to failover, then the 30 s TTL");
  // Two external endpoints: the containers' public names, uksouth first.
  const { uks, ukw } = aciByRegion(l);
  const eps = resources(l, "azurerm_traffic_manager_external_endpoint");
  assert.equal(eps.length, 2);
  for (const e of eps) assert.equal(attr(e.body, "profile_id"), `azurerm_traffic_manager_profile.${tm.labels[1]}.id`);
  const priority = Object.fromEntries(eps.map((e) => [attr(e.body, "target"), attr(e.body, "priority")]));
  assert.deepEqual(priority, { [`azurerm_container_group.${uks.labels[1]}.fqdn`]: "1", [`azurerm_container_group.${ukw.labels[1]}.fqdn`]: "2" });
  assert.equal(resources(l, "azurerm_traffic_manager_azure_endpoint").length + resources(l, "azurerm_traffic_manager_nested_endpoint").length, 0);
});

test(`${MR}: Front Door Standard with one origin group of both origins and one route, no WAF`, () => {
  const l = lab(MR);
  const p = one(l, "azurerm_cdn_frontdoor_profile");
  const profileId = `azurerm_cdn_frontdoor_profile.${p.labels[1]}.id`;
  assert.equal(attr(p.body, "resource_group_name"), IN_LAB, "global, kept in rg-lab-<id>");
  assert.equal(attr(p.body, "sku_name"), '"Standard_AzureFrontDoor"', "Standard: Premium's base fee is far higher");
  const ep = one(l, "azurerm_cdn_frontdoor_endpoint");
  assert.equal(attr(ep.body, "cdn_frontdoor_profile_id"), profileId);
  const og = one(l, "azurerm_cdn_frontdoor_origin_group");
  assert.equal(attr(og.body, "cdn_frontdoor_profile_id"), profileId);
  const probe = nested(og.body, "health_probe");
  assert.deepEqual([attr(probe, "protocol"), attr(probe, "path"), attr(probe, "interval_in_seconds")], ['"Http"', '"/"', "100"]);
  const lb = nested(og.body, "load_balancing");
  assert.deepEqual([attr(lb, "sample_size"), attr(lb, "successful_samples_required")], ["4", "3"]);
  // Two origins, the containers' public names, uksouth first; each is sent its own host name.
  const { uks, ukw } = aciByRegion(l);
  const origins = resources(l, "azurerm_cdn_frontdoor_origin");
  assert.equal(origins.length, 2);
  const priority = {};
  for (const o of origins) {
    assert.equal(attr(o.body, "cdn_frontdoor_origin_group_id"), `azurerm_cdn_frontdoor_origin_group.${og.labels[1]}.id`);
    assert.equal(attr(o.body, "origin_host_header"), attr(o.body, "host_name"));
    assert.equal(attr(o.body, "http_port"), "80");
    assert.equal(attr(o.body, "certificate_name_check_enabled"), "true");
    priority[attr(o.body, "host_name")] = attr(o.body, "priority");
  }
  assert.deepEqual(priority, { [`azurerm_container_group.${uks.labels[1]}.fqdn`]: "1", [`azurerm_container_group.${ukw.labels[1]}.fqdn`]: "2" });
  // One route: everything, HTTP and HTTPS in, HTTP to the origins, no caching.
  const r = one(l, "azurerm_cdn_frontdoor_route").body;
  assert.equal(attr(r, "cdn_frontdoor_endpoint_id"), `azurerm_cdn_frontdoor_endpoint.${ep.labels[1]}.id`);
  assert.equal(attr(r, "cdn_frontdoor_origin_group_id"), `azurerm_cdn_frontdoor_origin_group.${og.labels[1]}.id`);
  assert.deepEqual(strings(attr(r, "patterns_to_match")), ["/*"]);
  assert.deepEqual(strings(attr(r, "supported_protocols")).sort(), ["Http", "Https"]);
  assert.equal(attr(r, "forwarding_protocol"), '"HttpOnly"');
  assert.equal(nested(r, "cache"), undefined, "no caching: every request reaches an origin, so a failover shows at once");
  assert.equal(attr(r, "cdn_frontdoor_origin_ids"), `[${origins.map((o) => `azurerm_cdn_frontdoor_origin.${o.labels[1]}.id`).join(", ")}]`);
  // No WAF, no custom domain, no rule set.
  assert.deepEqual(resources(l).map((x) => x.labels[0]).filter((t) => /firewall|security_policy|custom_domain|rule_set|_rule$|secret/.test(t)), []);
});

test(`${MR}: no App Service and no azurerm_public_ip`, () => {
  const l = lab(MR);
  // Ruling 23: App Service quota is 0, so the backends are container instances.
  assert.deepEqual(resources(l).map((r) => r.labels[0]).filter((t) => /service_plan|web_app|app_service|function_app|container_app/.test(t)), []);
  assert.equal(resources(l, "azurerm_public_ip").length, 0);
  // No network of its own: nothing to peer, no addresses from the slot.
  assert.equal(resources(l, "azurerm_virtual_network").length, 0);
  assert.deepEqual(l.yaml.connectivity, { peering: "off", dns_link: false, subnets_used: 0 });
});

test(`${MR}: connect lists the Traffic Manager and Front Door URLs`, () => {
  const l = lab(MR);
  const connect = l.blocks.find((b) => b.kind === "output" && b.labels[0] === "connect")?.body ?? "";
  assert.match(connect, /"[^"\n]*http:\/\/\$\{azurerm_traffic_manager_profile\.[a-z0-9_]+\.fqdn\}[^"\n]*"/);
  assert.match(connect, /"[^"\n]*https:\/\/\$\{azurerm_cdn_frontdoor_endpoint\.[a-z0-9_]+\.host_name\}[^"\n]*"/);
  const { uks, ukw } = aciByRegion(l);
  for (const g of [uks, ukw]) assert.ok(connect.includes(`http://\${azurerm_container_group.${g.labels[1]}.fqdn}`), `${g.labels[1]}'s own URL`);
  assert.equal(l.blocks.find((b) => b.kind === "output" && b.labels[0] === "private_ips")?.body.trim(), "value = {}");
});

test(`${MR}: Front Door's base fee and both regions' containers are priced, authored where the feed cannot price them`, () => {
  const y = lab(MR).yaml;
  // Front Door Standard's base fee: £26.4161 a month per profile, priced under region "Zone N" (no uksouth row).
  const fd = y.cost.items.find((i) => /Front Door/.test(i.name) && /base fee/i.test(i.name));
  assert.ok(fd, "a Front Door base fee item");
  assert.equal(fd.retail, undefined, "authored: the feed has no uksouth row for it");
  assert.ok(fd.gbp_h >= Math.floor((26.4161 / 730) * 10000) / 10000, `£${fd.gbp_h}/h covers £26.4161 a month`);
  assert.equal(y.cost.pricey, fd.name, "the card names the base fee as what makes it pricey");
  // ACI in each region, vCPU and memory (ruling 2: shared meter, and a unit the feed cannot read).
  const aci = y.cost.items.filter((i) => /Container Instances/.test(i.name));
  assert.equal(aci.filter((i) => !i.region).length, 2, "vCPU and memory in uksouth");
  assert.equal(aci.filter((i) => i.region === "secondary").length, 2, "vCPU and memory in ukwest");
  // Traffic Manager: a health-checked external endpoint each.
  const tm = y.cost.items.find((i) => /Traffic Manager/.test(i.name) && /health check/i.test(i.name));
  assert.equal(tm?.qty, 2);
  assert.deepEqual(y.cost.items.filter((i) => i.retail).map((i) => i.name), [], "no meter here is unique in uksouth");
  assert.deepEqual(y.capacity.vm_sizes, []);
  assert.deepEqual(y.timing, { deploy_min: 12, destroy_min: 12, session_h: 2, max_h: 4 });
  assert.equal(Math.min(150, 2 * (y.timing.deploy_min + y.timing.destroy_min) + 20), 68);
});

test(`${MR}: the readme says how Front Door is billed, that the edge takes minutes, and how each front end fails over`, () => {
  const r = lab(MR).readme;
  assert.match(r, /uksouth[^\n]*ukwest[^\n]*pair/, "the lab must be deployed in uksouth with ukwest as its pair");
  assert.match(r, /`rg-lab-az305-27-multi-region-secondary`/);
  assert.match(r, /base fee[^\n]*hour/i, "Front Door's base fee is billed by the hour");
  assert.match(r, /minutes/);
  assert.match(r, /az container stop/);
  assert.match(r, /Host header/);
  assert.match(r, /App Service/, "why no App Service (readme only)");
});
