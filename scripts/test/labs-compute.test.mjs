// labs-compute.test.mjs
//
// Plain English: the compute labs (batch 2 plan area B1: labs 8 to 12)
// checked without touching Azure. Each lab runs the shared content suite
// (fixtures/labs/content.mjs: catalogue rules, lint, one resource group,
// lab.yaml agreeing with the Terraform, no public IPs, prices, marker, fmt),
// then its own tests below, named as the plan names them. lab-plans.test.mjs
// runs each lab's realistic plan (fixtures/labs/plans/labs/<id>.mjs) through
// the scope check; npm run labs-tf does init and validate.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attr, lab, labContentSuite, outputs, resources, uncomment } from "./fixtures/labs/content.mjs";

/** The body of resource `type.name` (asserts it exists). */
function body(l, type, name) {
  const r = resources(l, type).find((x) => x.labels[1] === name);
  assert.ok(r, `${type}.${name} exists`);
  return r.body;
}
/** All of a lab's .tf text, comments blanked. */
const tfText = (l) => uncomment(Object.values(l.files).join("\n"));
/** All of a lab's locals blocks, together. */
const localsText = (l) => l.blocks.filter((b) => b.kind === "locals").map((b) => b.body).join("\n");

// ── Lab 8: VMs, availability zones, disks and extensions ────────────────

const L8 = "az104-08-vms";
labContentSuite(L8, { marker: "£" });

test(`${L8}: two Standard_B1s Ubuntu VMs in zones 1 and 2 with no public IP`, () => {
  const l = lab(L8);
  const vms = resources(l, "azurerm_linux_virtual_machine");
  assert.equal(vms.length, 2);
  assert.deepEqual(vms.map((v) => attr(v.body, "zone")).sort(), ['"1"', '"2"']);
  for (const v of vms) {
    assert.equal(attr(v.body, "size"), '"Standard_B1s"');
    assert.equal(attr(v.body, "offer"), '"ubuntu-24_04-lts"');
    assert.equal(attr(v.body, "sku"), '"server"');
    assert.equal(attr(v.body, "admin_password"), "var.admin_password");
    assert.match(v.body, /boot_diagnostics\s*\{\s*\}/, "boot diagnostics on, so the serial console works");
  }
  assert.equal(resources(l, "azurerm_public_ip").length, 0);
  assert.equal(resources(l, "azurerm_network_interface").length, 2);
});

test(`${L8}: a 4 GiB Standard SSD data disk in the first VM's zone, attached at LUN 0`, () => {
  const l = lab(L8);
  const disks = resources(l, "azurerm_managed_disk");
  assert.equal(disks.length, 1);
  const d = disks[0].body;
  assert.equal(attr(d, "disk_size_gb"), "4");
  assert.equal(attr(d, "storage_account_type"), '"StandardSSD_LRS"');
  assert.equal(attr(d, "create_option"), '"Empty"');
  assert.equal(attr(d, "zone"), attr(body(l, "azurerm_linux_virtual_machine", "zone1"), "zone"), "a zonal disk must be in its VM's zone");
  const att = resources(l, "azurerm_virtual_machine_data_disk_attachment");
  assert.equal(att.length, 1);
  assert.equal(attr(att[0].body, "lun"), "0");
  assert.equal(attr(att[0].body, "managed_disk_id"), `azurerm_managed_disk.${disks[0].labels[1]}.id`);
  assert.equal(attr(att[0].body, "virtual_machine_id"), "azurerm_linux_virtual_machine.zone1.id");
});

test(`${L8}: a Custom Script extension serves the VM's name on port 80 with python3 and installs nothing`, () => {
  const l = lab(L8);
  const exts = resources(l, "azurerm_virtual_machine_extension");
  assert.deepEqual(exts.map((e) => attr(e.body, "virtual_machine_id")).sort(), ["azurerm_linux_virtual_machine.zone1.id", "azurerm_linux_virtual_machine.zone2.id"], "one on each VM");
  for (const e of exts) {
    assert.equal(attr(e.body, "publisher"), '"Microsoft.Azure.Extensions"');
    assert.equal(attr(e.body, "type"), '"CustomScript"');
    assert.match(attr(e.body, "settings"), /commandToExecute\s*=\s*local\.serve_web/);
    assert.doesNotMatch(e.body, /protected_settings/, "nothing secret, so nothing hidden");
  }
  const cmd = localsText(l);
  assert.match(cmd, /serve_web\s*=/);
  assert.match(cmd, /hostname\s*>\s*\/srv\/www\/index\.html/, "serves the VM's name");
  assert.match(cmd, /python3 -m http\.server 80/);
  assert.match(cmd, /systemctl enable --now/, "a systemd unit, so it survives a reboot");
  assert.doesNotMatch(cmd, /\b(apt|apt-get|pip|snap|curl|wget)\b|fileUris/, "installs and downloads nothing");
  assert.ok(outputs(l).includes("peer_vnet_id"));
});

// ── Lab 9: VM Scale Sets and autoscale ──────────────────────────────────

const L9 = "az104-09-vmss";
labContentSuite(L9, { marker: "£" });

test(`${L9}: a Uniform scale set of Standard_B1s, 2 instances, no public IP, upgrade mode Manual`, () => {
  const l = lab(L9);
  assert.equal(resources(l, "azurerm_orchestrated_virtual_machine_scale_set").length, 0, "Uniform, not Flexible (ruling 6)");
  assert.equal(resources(l, "azurerm_linux_virtual_machine").length, 0);
  const sets = resources(l, "azurerm_linux_virtual_machine_scale_set");
  assert.equal(sets.length, 1);
  const s = sets[0].body;
  assert.equal(attr(s, "sku"), '"Standard_B1s"');
  assert.equal(attr(s, "instances"), "2");
  assert.equal(attr(s, "upgrade_mode"), '"Manual"');
  assert.equal(attr(s, "overprovision"), "false", "no extra instances while scaling, so quota and cost stay as priced");
  assert.equal(attr(s, "offer"), '"ubuntu-24_04-lts"');
  assert.equal(attr(s, "admin_password"), "var.admin_password");
  assert.doesNotMatch(s, /public_ip_address\s*\{/);
  assert.match(s, /lifecycle\s*\{\s*ignore_changes\s*=\s*\[instances\]/, "autoscale owns the instance count after deploy");
  // Each instance serves its name with python3 from a cloud-init systemd unit (ruling 5): nothing installed.
  assert.equal(attr(s, "custom_data"), 'filebase64("${path.module}/cloud-init.yaml")');
  const ci = readFileSync(join(l.tfDir, "cloud-init.yaml"), "utf8");
  assert.match(ci, /^#cloud-config/);
  assert.match(ci, /hostname > \/srv\/www\/index\.html/);
  assert.match(ci, /python3 -m http\.server 80/);
  assert.match(ci, /enable, --now, lab-web\.service/);
  assert.doesNotMatch(ci, /^\s*(packages|package_update|package_upgrade)\s*:/m, "no packages");
  assert.doesNotMatch(ci, /\b(apt|apt-get|pip|snap|curl|wget)\b/);
});

test(`${L9}: autoscale 1 to 3 on average CPU, out above 70% and in below 25%`, () => {
  const l = lab(L9);
  const scalers = resources(l, "azurerm_monitor_autoscale_setting");
  assert.equal(scalers.length, 1);
  const a = scalers[0].body;
  assert.equal(attr(a, "target_resource_id"), "azurerm_linux_virtual_machine_scale_set.web.id");
  assert.equal(attr(a, "minimum"), "1");
  assert.equal(attr(a, "maximum"), "3");
  assert.equal(attr(a, "default"), "2");
  const rules = [...a.matchAll(/rule\s*\{([\s\S]*?scale_action\s*\{[\s\S]*?\})/g)].map((m) => m[1]);
  assert.equal(rules.length, 2);
  const rule = (direction) => rules.find((r) => attr(r, "direction") === `"${direction}"`);
  for (const [direction, operator, threshold] of [["Increase", "GreaterThan", "70"], ["Decrease", "LessThan", "25"]]) {
    const r = rule(direction);
    assert.ok(r, `a ${direction} rule`);
    assert.equal(attr(r, "metric_name"), '"Percentage CPU"');
    assert.equal(attr(r, "metric_resource_id"), "azurerm_linux_virtual_machine_scale_set.web.id");
    assert.equal(attr(r, "time_aggregation"), '"Average"');
    assert.equal(attr(r, "operator"), `"${operator}"`);
    assert.equal(attr(r, "threshold"), threshold);
    assert.equal(attr(r, "value"), '"1"');
  }
});

test(`${L9}: vm_sizes lists three Standard_B1s, the autoscale maximum, and the cost two`, () => {
  const y = lab(L9).yaml;
  assert.deepEqual(y.capacity.vm_sizes, ["Standard_B1s", "Standard_B1s", "Standard_B1s"]);
  assert.equal(y.cost.items.find((i) => i.retail?.sku === "Standard_B1s").qty, 2);
  assert.equal(y.cost.items.find((i) => i.retail?.meter === "S4 LRS Disk").qty, 2);
  assert.deepEqual(y.prerequisites, ["az104-08-vms"]);
});
