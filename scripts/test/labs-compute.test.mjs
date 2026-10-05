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
