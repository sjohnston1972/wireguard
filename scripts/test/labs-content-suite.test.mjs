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
import { addressProblems, CHILD_TYPES, contentChecks, costMarker, estimateGbpH, lab, labContentSuite, resources, roleAssignments } from "./fixtures/labs/content.mjs";
import { LAB_PLANS } from "./fixtures/labs/plans/labs.mjs";

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

// ── AZ-700 plan Z0.4: test 6, addresses, and ruling 50's public IPs ──────
// suite/az700-95-addresses: two VNets and a P2S client pool at slot 31, its plan fixture in plan.mjs.

const ADDRESSES = "every VNet, hub prefix and client pool is inside the slot and none overlap";
const L95 = "az700-95-addresses";
const plan95 = (await import("./fixtures/labs/suite/az700-95-addresses/plan.mjs")).default;
/** The plan description with `edit` applied to the resource at `address` (and the whole description). */
const plan95With = (address, edit) => () => {
  const d = plan95();
  edit(d.resources.find((r) => r.address === address), d);
  return d;
};

test("the address test refuses two VNets that overlap and a client pool outside the slot", () => {
  check(L95, ADDRESSES, { plan: plan95 })();
  assert.equal(plan95().variables.address_space, "10.71.192.0/18", "AZ-700 fixtures are at slot 31");
  // Two VNets sharing addresses.
  assert.throws(() => check(L95, ADDRESSES, { plan: plan95With("azurerm_virtual_network.onprem", (r) => (r.values.address_space = ["10.71.200.0/21"])) })(), /azurerm_virtual_network\.hub .*overlaps.*azurerm_virtual_network\.onprem/);
  // A client pool outside the slot, and one inside a VNet.
  assert.throws(() => check(L95, ADDRESSES, { plan: plan95With("azurerm_virtual_network_gateway.gw", (r) => (r.values.vpn_client_configuration[0].address_space = ["10.72.0.0/24"])) })(), /client pool 10\.72\.0\.0\/24 is outside the slot/);
  assert.throws(() => check(L95, ADDRESSES, { plan: plan95With("azurerm_virtual_network_gateway.gw", (r) => (r.values.vpn_client_configuration[0].address_space = ["10.71.193.0/24"])) })(), /overlaps/);
  // A VNet outside the slot.
  assert.throws(() => check(L95, ADDRESSES, { plan: plan95With("azurerm_virtual_network.onprem", (r) => (r.values.address_space = ["10.64.0.0/20"])) })(), /outside the slot/);
  // A virtual hub's prefix: inside the slot and clear of the VNets.
  const hub = (prefix) => (_, d) => d.resources.push({ address: "azurerm_virtual_hub.hub", values: { name: "vhub", address_prefix: prefix } });
  check(L95, ADDRESSES, { plan: plan95With("azurerm_resource_group.lab", hub("10.71.240.0/23")) })();
  assert.throws(() => check(L95, ADDRESSES, { plan: plan95With("azurerm_resource_group.lab", hub("10.71.208.0/23")) })(), /azurerm_virtual_hub\.hub/);
  assert.throws(() => check(L95, ADDRESSES, { plan: plan95With("azurerm_resource_group.lab", hub("10.80.0.0/23")) })(), /outside the slot/);
  // A VNet whose address space the plan does not know cannot be checked: the fixture gives it (cidrsubnet of the slot is known at plan).
  assert.throws(() => check(L95, ADDRESSES, { plan: plan95With("azurerm_virtual_network.onprem", (r) => delete r.values.address_space) })(), /address_space/);
  // Without a plan fixture the check says so.
  assert.throws(() => check(L95, ADDRESSES, { plan: () => undefined })(), /plan fixture/);
  // addresses: false leaves the check out.
  assert.ok(!contentChecks(L95, { marker: "££", labsDir: SUITE, plan: plan95, addresses: false }).some((c) => c.name.endsWith(ADDRESSES)));
});

test("every lab's plan fixture passes the address check (labs 1 to 27)", () => {
  for (const [id, d] of Object.entries(LAB_PLANS)) assert.deepEqual(addressProblems(d), [], id);
});

// AZ-700 plan Z0.5, scope exception S2 (approved by Steven 2026-10-05): lab 44's flow log lives under the region's
// Network Watcher in NetworkWatcherRG; test 3 lets exactly that resource of exactly that lab name that group.
test("test 3 lets lab 44's flow log, and nothing else, be in NetworkWatcherRG (S2)", () => {
  const ONE_GROUP = "one resource group, named by the pipeline, and everything else inside it with the tags";
  const withFlowLog = (type = "azurerm_network_watcher_flow_log", rg = '"NetworkWatcherRG"') => {
    const l = lab(L95, SUITE);
    l.blocks.push({ kind: "resource", labels: [type, "vnet"], body: `\n  name                 = "lab-\${var.lab_id}-vnet"\n  resource_group_name  = ${rg}\n  network_watcher_name = "NetworkWatcher_\${var.region}"\n  tags                 = var.tags\n` });
    return l;
  };
  const run = (id, l) => contentChecks(id, { marker: "£££", labsDir: SUITE, load: () => l }).find((c) => c.name === `${id}: ${ONE_GROUP}`).fn();
  run("az700-44-flow-logs-bastion", withFlowLog());
  // Another lab, another type, or another group: refused.
  assert.throws(() => run(L95, withFlowLog()), /azurerm_network_watcher_flow_log\.vnet/);
  assert.throws(() => run("az700-44-flow-logs-bastion", withFlowLog("azurerm_storage_account")), /azurerm_storage_account\.vnet/);
  assert.throws(() => run("az700-44-flow-logs-bastion", withFlowLog(undefined, '"rg-prod"')), /azurerm_network_watcher_flow_log\.vnet/);
});

const PUBLIC_IPS = "VMs have no public IP and use the sizes and disks lab.yaml prices";
test("a public IP belongs to a gateway, Route Server, firewall, Bastion, App Gateway or load balancer frontend, never a VM (ruling 50)", () => {
  // The VPN gateway owns pip-gw.
  check(L95, PUBLIC_IPS)();
  /** Lab 95 with the gateway's public IP taken off it and given to a resource of `type` instead. */
  const withOwner = (type, body) => {
    const l = lab(L95, SUITE);
    const gw = l.blocks.find((b) => b.labels.join(".") === "azurerm_virtual_network_gateway.gw");
    gw.body = gw.body.replace("azurerm_public_ip.gw.id", '"none"');
    if (type) l.blocks.push({ kind: "resource", labels: [type, "owner"], body });
    return l;
  };
  for (const type of ["azurerm_route_server", "azurerm_firewall", "azurerm_bastion_host", "azurerm_lb", "azurerm_application_gateway", "azurerm_nat_gateway_public_ip_association"]) {
    check(L95, PUBLIC_IPS, { load: () => withOwner(type, "x {\n  public_ip_address_id = azurerm_public_ip.gw.id\n}") })();
  }
  // Owned by nothing, by a type not on ruling 50's list, or by a VM's NIC: refused.
  assert.throws(() => check(L95, PUBLIC_IPS, { load: () => withOwner(null) })(), /azurerm_public_ip\.gw/);
  assert.throws(() => check(L95, PUBLIC_IPS, { load: () => withOwner("azurerm_container_group", "ip = azurerm_public_ip.gw.id") })(), /azurerm_public_ip\.gw/);
  assert.throws(() => check(L95, PUBLIC_IPS, { load: () => withOwner("azurerm_network_interface", "ip_configuration {\n  public_ip_address_id = azurerm_public_ip.gw.id\n}") })(), /public IP/);
});
