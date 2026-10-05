// lab-scope.test.mjs
//
// Plain English: the plan-time scope check (infra/ci/lab-scope.mjs, labs spec
// §8.4) against fixture plans. Each fixture in fixtures/labs/scope/ holds the
// same lab twice: as `terraform show -json` would print its plan, and as
// hcl2json would print its .tf files. Clean fixtures must pass; each evil one
// must be refused, naming its rule, in both forms.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkHcl, checkPlan, RULES, GOVERNANCE_LABS as SCOPE_GOVERNANCE, LAB_ID_RE as SCOPE_ID_RE } from "../../infra/ci/lab-scope.mjs";
import { GOVERNANCE_LABS, LAB_ID_RE } from "../lib/labs.mjs";
import { withAfterUnknown } from "./fixtures/labs/plans/realistic.mjs";
import { LAB_PLANS } from "./fixtures/labs/plans/labs.mjs";

const DIR = fileURLToPath(new URL("./fixtures/labs/scope/", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../../infra/ci/lab-scope.mjs", import.meta.url));
// Each plan gets resource_changes with after_unknown as Terraform prints it for
// a first deploy (computed attributes left unset are unknown at plan), so a
// fixture cannot be tidier than a real plan.
const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ file: f, ...JSON.parse(readFileSync(join(DIR, f), "utf8")) }))
  .map((f) => ({ ...f, plan: withAfterUnknown(f.plan) }));

/** [rule, address] pairs, sorted, with any [index] taken off the address. */
const verdict = (problems) => problems.map((p) => [p.rule, p.address.replace(/\[[^\]]*\]/g, "")]).sort((a, b) => (a.join() < b.join() ? -1 : 1));
const sorted = (pairs) => [...pairs].sort((a, b) => (a.join() < b.join() ? -1 : 1));

test("lab-scope's own copies of the governance labs and the id pattern equal the contract's", () => {
  // lab-scope.mjs runs on the runner without npm ci, so it cannot import scripts/lib/labs.mjs.
  assert.deepEqual([...SCOPE_GOVERNANCE], [...GOVERNANCE_LABS]);
  assert.equal(SCOPE_ID_RE.source, LAB_ID_RE.source);
});

test("a clean plan for the template passes", () => {
  const f = fixtures.find((x) => x.file === "clean-template.json");
  assert.deepEqual(checkPlan(f.plan, f.lab), []);
  assert.deepEqual(checkHcl(f.hcl, f.lab), []);
});

test("clean plans for labs like 1, 3 and 6 pass in both forms", () => {
  for (const f of fixtures.filter((x) => x.file.startsWith("clean-"))) {
    assert.deepEqual(verdict(checkPlan(f.plan, f.lab)), [], `${f.file} (plan)`);
    assert.deepEqual(verdict(checkHcl(f.hcl, f.lab)), [], `${f.file} (hcl)`);
  }
});

test("lab-scope refuses each evil plan naming its rule", () => {
  const evil = fixtures.filter((x) => x.file.startsWith("evil-"));
  const covered = new Set();
  for (const f of evil) {
    assert.deepEqual(verdict(checkPlan(f.plan, f.lab)), sorted(f.expect), f.file);
    for (const [rule] of f.expect) covered.add(rule);
  }
  // Every rule has at least one evil fixture.
  assert.deepEqual([...covered].sort(), [...RULES].sort());
});

test("HCL mode gives the same verdicts on the HCL fixtures", () => {
  for (const f of fixtures) assert.deepEqual(verdict(checkHcl(f.hcl, f.lab)), sorted(f.expect), f.file);
});

/** A lab's governance objects, as hcl2json prints them: a prefixed policy definition and management group. */
const governanceHcl = (extra = {}) => ({
  resource: {
    azurerm_resource_group: { lab: [{ name: "${var.resource_group_name}", location: "${var.region}" }] },
    azurerm_policy_definition: { tags: [{ name: "lab-${var.lab_id}-tags", display_name: "lab-${var.lab_id}-tags", policy_type: "Custom", mode: "All" }] },
    azurerm_management_group: { root: [{ name: "lab-${var.lab_id}-root", display_name: "lab-${var.lab_id}-root" }] },
    ...extra,
  },
});

test("governance types pass only for the five governance labs and never at subscription scope", () => {
  assert.equal(GOVERNANCE_LABS.length, 5);
  for (const id of GOVERNANCE_LABS) assert.deepEqual(checkHcl(governanceHcl(), id), [], id);
  for (const id of ["az104-06-blob-security", "az104-04-cost", "az305-22-keyvault-mi"]) {
    assert.deepEqual(verdict(checkHcl(governanceHcl(), id)), [["governance", "azurerm_management_group.root"], ["governance", "azurerm_policy_definition.tags"]], id);
  }
  const atSubscription = {
    azurerm_role_assignment: { sub: [{ scope: "/subscriptions/00000000-0000-0000-0000-000000000000", role_definition_name: "Reader", principal_id: "11111111-1111-1111-1111-111111111111" }] },
    azurerm_subscription_policy_assignment: { sub: [{ name: "x", subscription_id: "${data.azurerm_subscription.current.id}", policy_definition_id: "${azurerm_policy_definition.tags.id}" }] },
  };
  for (const id of GOVERNANCE_LABS) {
    assert.deepEqual(verdict(checkHcl({ data: { azurerm_subscription: { current: [{}] } }, ...governanceHcl(atSubscription) }, id)), [["outside-scope", "azurerm_role_assignment.sub"], ["outside-scope", "azurerm_subscription_policy_assignment.sub"]], id);
  }
});

test("a lab's custom role must be its own: another lab's custom role id is refused", () => {
  const hcl = governanceHcl({
    azurerm_role_assignment: { x: [{ scope: "${azurerm_resource_group.lab.id}", role_definition_id: "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/7331dcae-09d3-477e-8da7-2895697f0fc0", principal_id: "11111111-1111-1111-1111-111111111111" }] },
  });
  assert.deepEqual(checkHcl(hcl, "az104-01-identity"), []);
  assert.deepEqual(verdict(checkHcl(hcl, "az104-02-policy")), [["role", "azurerm_role_assignment.x"]]);
});

test("a lab custom role: no wildcard actions, and assignable only inside the lab's group", () => {
  const id = "az104-01-identity";
  const role = (permissions, assignable) => ({
    data: { azurerm_subscription: { current: [{}] } },
    resource: {
      azurerm_resource_group: { lab: [{ name: "${var.resource_group_name}", location: "${var.region}" }], other: [{ name: "${var.resource_group_name}-x", location: "${var.region}" }] },
      azurerm_role_definition: {
        r: [{ role_definition_id: "7331dcae-09d3-477e-8da7-2895697f0fc0", name: "lab-${var.lab_id}-vm-operator", scope: "${data.azurerm_subscription.current.id}", permissions: [permissions], ...(assignable === undefined ? {} : { assignable_scopes: assignable }) }],
      },
    },
  });
  const ownRg = ["${azurerm_resource_group.lab.id}"];
  const reads = { actions: ["Microsoft.Compute/virtualMachines/read", "Microsoft.Compute/virtualMachines/start/action"], not_actions: [] };
  assert.deepEqual(checkHcl(role(reads, ownRg), id), []);
  // Wildcard reads grant nothing but reading.
  assert.deepEqual(checkHcl(role({ actions: ["*/read", "Microsoft.Compute/*/read"] }, ownRg), id), []);
  // A nested group of the lab (rg-lab-<id>-x) is still the lab's.
  assert.deepEqual(checkHcl(role(reads, ["${azurerm_resource_group.other.id}"]), id), []);
  for (const actions of [["*"], ["*/write"], ["*/delete"], ["Microsoft.Authorization/*"], ["Microsoft.Authorization/roleAssignments/write"], ["Microsoft.Compute/*"], ["Microsoft.Compute/virtualMachines/*"]]) {
    assert.deepEqual(verdict(checkHcl(role({ actions }, ownRg), id)), [["role", "azurerm_role_definition.r"]], actions.join());
  }
  assert.deepEqual(verdict(checkHcl(role({ actions: ["Microsoft.Compute/virtualMachines/read"], data_actions: ["Microsoft.Storage/storageAccounts/blobServices/containers/blobs/*"] }, ownRg), id)), [["role", "azurerm_role_definition.r"]], "data actions");
  // Assignable anywhere else: the subscription, another group, or left unset (Azure then uses the definition's scope, the subscription).
  for (const assignable of [["${data.azurerm_subscription.current.id}"], ["/subscriptions/3f2b7c1e-5a4d-4e8f-9b6a-2c1d0e9f8a7b"], ["/subscriptions/3f2b7c1e-5a4d-4e8f-9b6a-2c1d0e9f8a7b/resourceGroups/rg-lab-az104-02-policy"], ["/subscriptions/3f2b7c1e-5a4d-4e8f-9b6a-2c1d0e9f8a7b/resourceGroups/rg-prod"], undefined, []]) {
    assert.deepEqual(verdict(checkHcl(role(reads, assignable), id)), [["role", "azurerm_role_definition.r"]], JSON.stringify(assignable));
  }
  // The real lab 1 plan (assignable_scopes unknown, from the lab's group) passes; a known subscription scope does not.
  const plan = structuredClone(LAB_PLANS[id].plan);
  assert.deepEqual(checkPlan(plan, id), []);
  const rd = plan.planned_values.root_module.resources.find((r) => r.type === "azurerm_role_definition");
  rd.values.assignable_scopes = ["/subscriptions/3f2b7c1e-5a4d-4e8f-9b6a-2c1d0e9f8a7b"];
  plan.resource_changes.find((c) => c.address === rd.address).change.after_unknown.assignable_scopes = false;
  plan.configuration.root_module.resources.find((r) => r.address === rd.address).expressions.assignable_scopes = { references: ["data.azurerm_subscription.current.id", "data.azurerm_subscription.current"] };
  assert.deepEqual(verdict(checkPlan(plan, id)), [["role", "azurerm_role_definition.vm_operator"]]);
});

test("an ARM template deployment may not reach outside the lab or assign roles", () => {
  const tpl = (resources) => ({
    resource: {
      azurerm_resource_group: { lab: [{ name: "${var.resource_group_name}", location: "${var.region}" }] },
      azurerm_resource_group_template_deployment: { t: [{ name: "t", resource_group_name: "${azurerm_resource_group.lab.name}", deployment_mode: "Incremental", template_content: JSON.stringify({ $schema: "x", resources }) }] },
    },
  });
  const id = "az104-12-bicep";
  assert.deepEqual(checkHcl(tpl([{ type: "Microsoft.Storage/storageAccounts", name: "x", apiVersion: "2023-01-01" }]), id), []);
  assert.deepEqual(verdict(checkHcl(tpl([{ type: "Microsoft.Resources/deployments", name: "n", resourceGroup: "rg-prod", apiVersion: "2022-09-01" }]), id)), [["outside-scope", "azurerm_resource_group_template_deployment.t"]]);
  assert.deepEqual(verdict(checkHcl(tpl([{ type: "Microsoft.Authorization/roleAssignments", name: "n", apiVersion: "2022-04-01" }]), id)), [["role", "azurerm_resource_group_template_deployment.t"]]);
});

test("the command line prints one rule: address line per refusal and exits 1; a clean plan exits 0", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lab-scope-"));
  const evil = fixtures.find((x) => x.file === "evil-role.json");
  const clean = fixtures.find((x) => x.file === "clean-identity.json");
  writeFileSync(join(tmp, "evil.json"), JSON.stringify(evil.plan));
  writeFileSync(join(tmp, "clean.json"), JSON.stringify(clean.hcl));
  const bad = spawnSync(process.execPath, [SCRIPT, "--plan", join(tmp, "evil.json"), "--lab", evil.lab], { encoding: "utf8" });
  assert.equal(bad.status, 1, bad.stderr);
  const lines = bad.stdout.trim().split("\n").filter((l) => /^[a-z-]+: /.test(l));
  assert.equal(lines.length, evil.expect.length);
  for (const [rule, address] of evil.expect) assert.ok(lines.some((l) => l.startsWith(`${rule}: ${address}`)), `${rule}: ${address}`);
  const good = spawnSync(process.execPath, [SCRIPT, "--hcl", join(tmp, "clean.json"), "--lab", clean.lab], { encoding: "utf8" });
  assert.equal(good.status, 0, good.stdout + good.stderr);
  const usage = spawnSync(process.execPath, [SCRIPT, "--plan", join(tmp, "clean.json"), "--lab", "not a lab"], { encoding: "utf8" });
  assert.equal(usage.status, 2);
});

test("lab-scope never prints a sensitive value", () => {
  const f = fixtures.find((x) => x.file === "evil-entra-prefix.json");
  const plan = structuredClone(f.plan);
  const boss = plan.planned_values.root_module.resources.find((r) => r.address === "azuread_user.boss");
  boss.values.password = "Sup3r-Secret-Value!";
  boss.sensitive_values = { password: true };
  const tmp = mkdtempSync(join(tmpdir(), "lab-scope-"));
  writeFileSync(join(tmp, "p.json"), JSON.stringify(plan));
  const r = spawnSync(process.execPath, [SCRIPT, "--plan", join(tmp, "p.json"), "--lab", f.lab], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.ok(!(r.stdout + r.stderr).includes("Sup3r-Secret-Value!"));
});

test("a management group's subscription_ids: unknown because unset passes; set in the configuration or a known list is refused", () => {
  const lab = "az104-03-mgmt-groups";
  const mg = (values, expressions, after_unknown) => ({
    planned_values: { root_module: { resources: [{ address: "azurerm_management_group.root", mode: "managed", type: "azurerm_management_group", name: "root", provider_name: "registry.terraform.io/hashicorp/azurerm", values }] } },
    resource_changes: [{ address: "azurerm_management_group.root", change: { actions: ["create"], after_unknown } }],
    configuration: { root_module: { resources: [{ address: "azurerm_management_group.root", mode: "managed", type: "azurerm_management_group", name: "root", expressions }] } },
  });
  const name = { name: "lab-az104-03-mgmt-groups-root", display_name: "lab-az104-03-mgmt-groups-root" };
  const named = { name: { references: ["var.lab_id"] } };
  // Unset: the provider reads it back after apply, so every real plan has it unknown.
  assert.deepEqual(checkPlan(mg(name, named, { id: true, subscription_ids: true }), lab), []);
  // Set from something only known at apply.
  assert.deepEqual(verdict(checkPlan(mg(name, { ...named, subscription_ids: { references: ["data.azurerm_subscription.current.subscription_id"] } }, { id: true, subscription_ids: true }), lab)), [["association", "azurerm_management_group.root"]]);
  // A known, non-empty list.
  assert.deepEqual(verdict(checkPlan(mg({ ...name, subscription_ids: ["3f2b7c1e-5a4d-4e8f-9b6a-2c1d0e9f8a7b"] }, named, { id: true }), lab)), [["association", "azurerm_management_group.root"]]);
  // Set to an empty list: nothing moves.
  assert.deepEqual(checkPlan(mg({ ...name, subscription_ids: [] }, { ...named, subscription_ids: { constant_value: [] } }, { id: true }), lab), []);
  // HCL: a list naming a subscription is refused.
  const hcl = { data: { azurerm_subscription: { current: [{}] } }, resource: { azurerm_management_group: { root: [{ name: "lab-${var.lab_id}-root", subscription_ids: ["${data.azurerm_subscription.current.subscription_id}"] }] } } };
  assert.deepEqual(verdict(checkHcl(hcl, lab)), [["association", "azurerm_management_group.root"]]);
});

test("HCL mode: an Entra user or group without mail_nickname is refused early (azuread makes one up, unknown at plan)", () => {
  const lab = "az104-06-blob-security";
  const hcl = (group) => ({ resource: { azurerm_resource_group: { lab: [{ name: "${var.resource_group_name}", location: "${var.region}" }] }, azuread_group: { readers: [group] } } });
  assert.deepEqual(verdict(checkHcl(hcl({ display_name: "lab-${var.lab_id}-readers", security_enabled: true }), lab)), [["entra-prefix", "azuread_group.readers"]]);
  assert.deepEqual(checkHcl(hcl({ display_name: "lab-${var.lab_id}-readers", mail_nickname: "lab-${var.lab_id}-readers", security_enabled: true }), lab), []);
});
