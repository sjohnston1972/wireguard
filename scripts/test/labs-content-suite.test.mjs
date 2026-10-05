// labs-content-suite.test.mjs
//
// Plain English: the shared content checks every batch 2 lab runs
// (fixtures/labs/content.mjs, labContentSuite), proved on a batch 1 lab that
// already passes its own: lab 7, a VM, a share and a VNet, at the £ marker.
// Batch 1's own content tests (labs-storage, labs-content-identity) stay as
// they are.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { CHILD_TYPES, contentChecks, costMarker, estimateGbpH, lab, labContentSuite, resources, roleAssignments } from "./fixtures/labs/content.mjs";

labContentSuite("az104-07-files", { marker: "£" });

test("CHILD_TYPES lists batch 1's child types and batch 2's (types with no tags of their own)", () => {
  for (const t of [
    "azurerm_storage_container",
    "azurerm_subnet",
    "azurerm_role_assignment",
    "azurerm_subnet_network_security_group_association",
    "azurerm_subnet_route_table_association",
    "azurerm_network_interface_application_security_group_association",
    "azurerm_lb_backend_address_pool",
    "azurerm_lb_probe",
    "azurerm_lb_rule",
    "azurerm_network_interface_backend_address_pool_association",
    "azurerm_virtual_machine_extension",
    "azurerm_virtual_machine_data_disk_attachment",
    "azurerm_virtual_network_peering",
    "azurerm_dns_a_record",
    "azurerm_private_dns_a_record",
    "azurerm_monitor_data_collection_rule_association",
    "azurerm_backup_policy_vm",
    "azurerm_backup_protected_vm",
  ]) {
    assert.ok(CHILD_TYPES.has(t), t);
  }
  assert.ok(!CHILD_TYPES.has("azurerm_linux_virtual_machine"));
});

test("the suite's estimate and marker follow the catalogue's rules (£ under £0.05/h, ££ under £0.50/h)", () => {
  assert.equal(estimateGbpH([{ gbp_h: 0.0092, qty: 2 }, { gbp_h: 0.0018 }]), 0.0202);
  assert.equal(costMarker(0.049, 5), "£");
  assert.equal(costMarker(0.05, 5), "££");
  assert.equal(costMarker(0.49, 12), "££");
  assert.equal(costMarker(0.5, 5), "£££");
  assert.equal(costMarker(0.01, 30), "£££");
  const l = lab("az104-07-files");
  assert.equal(resources(l, "azurerm_linux_virtual_machine").length, 1);
});

// ── Batch 3 (labs batch 3 plan, C0.1): the suite on small fixture labs ───
// fixtures/labs/suite/ holds labs that are not in the catalogue: one with a
// secondary group, one whose second group is rg-lab-<id>secondary, one whose
// role assignments lab.yaml lists (identity "match") and one with a VM
// replicated into the secondary region. Each check is run on its own.

const SUITE = fileURLToPath(new URL("./fixtures/labs/suite/", import.meta.url));
const TWO_GROUPS = "two resource groups, rg-lab-<id> in the region and rg-lab-<id>-secondary in the secondary region, and everything else inside one of them with the tags";
/** The suite's check called `name` (the text after "<id>: ") for a fixture lab, as a function. */
const check = (id, name, opts = {}) => {
  const c = contentChecks(id, { marker: "£", labsDir: SUITE, ...opts }).find((x) => x.name === `${id}: ${name}`);
  assert.ok(c, `${id}: no check named "${name}"`);
  return c.fn;
};
const IDENTITY = "lab.yaml agrees with the Terraform on peering, VM sizes, subnets and identity";

test("the suite accepts a lab with a secondary group and refuses a resource in rg-lab-<id>secondary", () => {
  const id = "az305-91-two-regions";
  check(id, TWO_GROUPS, { secondary: true })();
  // Without `secondary`, the one-group check refuses the second group.
  assert.throws(() => check(id, "one resource group, named by the pipeline, and everything else inside it with the tags")(), /AssertionError|Expected/);
  // rg-lab-<id>secondary is not the lab's.
  assert.throws(() => check("az305-92-bad-secondary", TWO_GROUPS, { secondary: true })(), /-secondary/);
  // lab.yaml must name the secondary region, and variables.tf must refuse an empty or equal one.
  const noRegion = lab(id, SUITE);
  noRegion.yaml.regions.secondary = null;
  assert.throws(() => check(id, TWO_GROUPS, { secondary: true, load: () => noRegion })(), /regions\.secondary/);
  const noValidation = lab(id, SUITE);
  noValidation.files["variables.tf"] = noValidation.files["variables.tf"].replace(/\n\s*validation \{[\s\S]*?\n\s{2}\}\n/, "\n");
  assert.doesNotMatch(noValidation.files["variables.tf"], /validation/);
  assert.throws(() => check(id, TWO_GROUPS, { secondary: true, load: () => noValidation })(), /secondary_region/);
  // A resource that takes a resource group (schema-facts.json) must name one of the lab's two.
  const stray = lab(id, SUITE);
  const sa = stray.blocks.find((b) => b.labels.join(".") === "azurerm_storage_account.secondary");
  sa.body = sa.body.replace("azurerm_resource_group.secondary.name", '"rg-elsewhere"');
  assert.throws(() => check(id, TWO_GROUPS, { secondary: true, load: () => stray })(), /azurerm_storage_account\.secondary/);
  // A resource whose type takes tags must carry var.tags; a child with neither (a container) needs nothing.
  const untagged = lab(id, SUITE);
  const p = untagged.blocks.find((b) => b.labels.join(".") === "azurerm_storage_account.primary");
  p.body = p.body.replace(/\n\s*tags\s*=\s*var\.tags/, "");
  assert.throws(() => check(id, TWO_GROUPS, { secondary: true, load: () => untagged })(), /var\.tags/);
});

test('identity "match" compares lab.yaml roles with the role assignments', () => {
  const id = "az305-93-identity";
  const l = lab(id, SUITE);
  assert.deepEqual(
    roleAssignments(l).map(({ address, role, scope, principalType }) => [address, role, scope, principalType]),
    [
      ["azurerm_role_assignment.reader", "Reader", "resource_group", "ServicePrincipal"],
      ["azurerm_role_assignment.ops", `lab-${id}-ops`, "resource_group", "ServicePrincipal"],
      ["azurerm_role_assignment.metrics", "Monitoring Reader", "resource", "ServicePrincipal"],
    ],
  );
  check(id, IDENTITY, { identity: "match" })();
  // "none" (batch 1-2) still refuses any role assignment.
  assert.throws(() => check(id, IDENTITY)(), /no role assignments/);
  // A role lab.yaml does not list, or lists at another scope, is refused.
  const missing = lab(id, SUITE);
  missing.yaml.identity.roles = missing.yaml.identity.roles.slice(1);
  assert.throws(() => check(id, IDENTITY, { identity: "match", load: () => missing })(), /identity\.roles/);
  const scoped = lab(id, SUITE);
  scoped.yaml.identity.roles[2].scope = "resource_group";
  assert.throws(() => check(id, IDENTITY, { identity: "match", load: () => scoped })(), /identity\.roles/);
  // Every role assignment says its principal type.
  const untyped = lab(id, SUITE);
  const ra = untyped.blocks.find((b) => b.labels.join(".") === "azurerm_role_assignment.metrics");
  ra.body = ra.body.replace(/\n\s*principal_type\s*=.*/, "");
  assert.throws(() => check(id, IDENTITY, { identity: "match", load: () => untyped })(), /principal_type/);
  // governance must equal GOVERNANCE_LABS membership.
  const gov = lab(id, SUITE);
  gov.yaml.identity.governance = true;
  assert.throws(() => check(id, IDENTITY, { identity: "match", load: () => gov })(), /governance/);
});

test("the suite prices S4 disks per region and counts a replicated VM's failover VM in vm_sizes", () => {
  const id = "az305-94-replica";
  check(id, TWO_GROUPS, { secondary: true })();
  check(id, IDENTITY)();
  check(id, "VMs have no public IP and use the sizes and disks lab.yaml prices", { secondary: true })();
  // The replica disk must be priced in the secondary region.
  const unpriced = lab(id, SUITE);
  unpriced.yaml.cost.items = unpriced.yaml.cost.items.filter((i) => !(i.region === "secondary" && i.retail?.meter));
  assert.throws(() => check(id, "VMs have no public IP and use the sizes and disks lab.yaml prices", { secondary: true, load: () => unpriced })(), /secondary/);
  // vm_sizes without the failover VM is short.
  const short = lab(id, SUITE);
  short.yaml.capacity.vm_sizes = ["Standard_B1s"];
  assert.throws(() => check(id, IDENTITY, { load: () => short })(), /vm_sizes/);
});
