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
import { checkHcl, checkPlan, hclResources, planResources, RULES, scopeProblems, templateProblems, GOVERNANCE_LABS as SCOPE_GOVERNANCE, LAB_ID_RE as SCOPE_ID_RE } from "../../infra/ci/lab-scope.mjs";
import { GOVERNANCE_LABS, LAB_ID_RE } from "../lib/labs.mjs";
import { realisticPlan, withAfterUnknown } from "./fixtures/labs/plans/realistic.mjs";
import { LAB_PLANS } from "./fixtures/labs/plans/labs.mjs";
import { ctx, IN_RG, linuxVm, ref, rgResource, rgSecondaryResource } from "./fixtures/labs/plans/common.mjs";
import { TEMPLATE as LAB12_TEMPLATE } from "./fixtures/labs/plans/labs/az104-12-bicep.mjs";

const DIR = fileURLToPath(new URL("./fixtures/labs/scope/", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../../infra/ci/lab-scope.mjs", import.meta.url));
/** A resource group deployment template's schema (Bicep's, for a resource group target). */
const RG_SCHEMA = "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#";
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
      azurerm_resource_group_template_deployment: { t: [{ name: "t", resource_group_name: "${azurerm_resource_group.lab.name}", deployment_mode: "Incremental", template_content: JSON.stringify({ $schema: RG_SCHEMA, resources }) }] },
    },
  });
  const id = "az104-12-bicep";
  assert.deepEqual(checkHcl(tpl([{ type: "Microsoft.Storage/storageAccounts", name: "x", apiVersion: "2023-01-01" }]), id), []);
  assert.deepEqual(verdict(checkHcl(tpl([{ type: "Microsoft.Resources/deployments", name: "n", resourceGroup: "rg-prod", apiVersion: "2022-09-01" }]), id)), [["outside-scope", "azurerm_resource_group_template_deployment.t"]]);
  assert.deepEqual(verdict(checkHcl(tpl([{ type: "Microsoft.Authorization/roleAssignments", name: "n", apiVersion: "2022-04-01" }]), id)), [["role", "azurerm_resource_group_template_deployment.t"]]);
});

// ── Templates (batch 2: lab 12 deploys Bicep through Terraform) ──────────

const BICEP_BUILT = JSON.parse(readFileSync(new URL("./fixtures/labs/bicep/storage-vnet.json", import.meta.url), "utf8"));
const TPL_LAB = "az104-12-bicep";
const TPL_ADDRESS = "azurerm_resource_group_template_deployment.main";
/** A template with these resources (an array, or languageVersion 2.0 symbolic resources as an object). */
const template = (resources, extra = {}) => ({ $schema: RG_SCHEMA, contentVersion: "1.0.0.0", resources, ...extra });
/** A nested deployment holding `inner` (a whole template) inline. */
const nested = (inner, extra = {}) => ({ type: "Microsoft.Resources/deployments", apiVersion: "2025-04-01", name: "inner", properties: { mode: "Incremental", expressionEvaluationOptions: { scope: "inner" }, template: inner, ...extra } });
const rules = (problems) => [...new Set(problems.map((p) => p.rule))].sort();
/** The lab's group and one template deployment of `content` (a string, or an HCL expression), as hcl2json prints them. */
const tplHcl = (content, extra = {}) => ({
  resource: {
    azurerm_resource_group: { lab: [{ name: "${var.resource_group_name}", location: "${var.region}", tags: "${var.tags}" }] },
    azurerm_resource_group_template_deployment: { main: [{ name: "lab-bicep", resource_group_name: "${azurerm_resource_group.lab.name}", deployment_mode: "Incremental", template_content: content, tags: "${var.tags}", ...extra }] },
  },
});
/** The same, as a realistic first-deploy plan: content known (a string) or unknown (null). */
const tplPlan = (content, extra = {}) => {
  const rg = `rg-lab-${TPL_LAB}`;
  const known = typeof content === "string";
  return realisticPlan({
    resources: [
      { address: "azurerm_resource_group.lab", values: { name: rg, location: "uksouth" }, refs: { name: ["var.resource_group_name"], location: ["var.region"] } },
      {
        address: TPL_ADDRESS,
        values: { name: "lab-bicep", resource_group_name: rg, deployment_mode: "Incremental", ...(known ? { template_content: content } : {}), ...extra },
        unknown: known ? [] : ["template_content"],
        refs: { resource_group_name: ["azurerm_resource_group.lab.name", "azurerm_resource_group.lab"], template_content: known ? ["path.module"] : ["azurerm_storage_account.x.primary_blob_endpoint", "azurerm_storage_account.x"] },
      },
    ],
  });
};

test("templateProblems passes a Bicep-built storage and VNet template", () => {
  // Built by the pinned Bicep from fixtures/labs/bicep/storage-vnet.bicep: languageVersion 2.0 symbolic resources and a module.
  assert.equal(BICEP_BUILT.languageVersion, "2.0");
  assert.ok(!Array.isArray(BICEP_BUILT.resources));
  assert.deepEqual(templateProblems(BICEP_BUILT), []);
  // Descriptions (template, parameter and resource metadata) may say anything.
  const described = { ...BICEP_BUILT, metadata: { ...BICEP_BUILT.metadata, description: "Not peered to vnet-wg in rg-wg-ondemand; ids like /subscriptions/x/resourceGroups/rg-other are not used." } };
  assert.deepEqual(templateProblems(described), []);
  // As a string, too, in a plan (file() of the built JSON is known at plan) and in HCL.
  assert.deepEqual(checkPlan(tplPlan(JSON.stringify(BICEP_BUILT)), TPL_LAB), []);
  assert.deepEqual(checkHcl(tplHcl(JSON.stringify(BICEP_BUILT)), TPL_LAB), []);
});

test("templateProblems reads anything named metadata that is not ARM's metadata slot", () => {
  // The gateway's VNet, by its literal id: what a private DNS zone link to it would name.
  const GW = "/subscriptions/3f2b7c1e-5a4d-4e8f-9b6a-2c1d0e9f8a7b/resourceGroups/rg-wg-ondemand/providers/Microsoft.Network/virtualNetworks/vnet-wg";
  const link = (id) => ({ type: "Microsoft.Network/privateDnsZones/virtualNetworkLinks", apiVersion: "2024-06-01", name: "lab.internal/to-wg", location: "global", properties: { registrationEnabled: false, virtualNetwork: { id } } });
  /** Each trick hides GW under a symbolic name; `name` is "metadata" for the trick, anything else for the control. */
  const tricks = (name) => [
    ["a variable", template([link(`[variables('${name}').id]`)], { variables: { [name]: { id: GW } } })],
    ["a parameter", template([link(`[parameters('${name}')]`)], { parameters: { [name]: { type: "string", defaultValue: GW } } })],
    ["a symbolic resource", template({ [name]: link(GW) }, { languageVersion: "2.0" })],
  ];
  for (const name of ["metadata", "link"]) {
    for (const [what, t] of tricks(name)) {
      const r = rules(templateProblems(t));
      assert.ok(r.includes("gateway") && r.includes("outside-scope"), `${what} called ${name}: ${JSON.stringify(templateProblems(t))}`);
      assert.deepEqual(verdict(checkPlan(tplPlan(JSON.stringify(t)), TPL_LAB)), [["gateway", TPL_ADDRESS]], `${what} called ${name} (plan)`);
    }
  }
  // ARM's own metadata slots stay descriptions: the template's, a parameter's, an output's, a definition's and a resource's.
  const words = { description: "Never peered to vnet-wg in rg-wg-ondemand." };
  const sa = { type: "Microsoft.Storage/storageAccounts", apiVersion: "2023-05-01", name: "x", location: "uksouth", kind: "StorageV2", sku: { name: "Standard_LRS" }, metadata: words };
  const described = template({ sa }, {
    languageVersion: "2.0",
    metadata: words,
    parameters: { p: { type: "string", defaultValue: "x", metadata: words } },
    definitions: { d: { type: "object", metadata: words, properties: { inner: { type: "string", metadata: words } } } },
    outputs: { o: { type: "string", value: "x", metadata: words } },
  });
  assert.deepEqual(templateProblems(described), []);
});

test("templateProblems reads template keys case-insensitively, as ARM does", () => {
  const cases = [
    ["Type", template([{ Type: "Microsoft.Authorization/roleAssignments", apiVersion: "2022-04-01", name: "x" }]), "role"],
    ["TYPE in a module", template([nested(template([{ TYPE: "Microsoft.Authorization/locks", apiVersion: "2020-05-01", name: "x" }]))]), "role"],
    ["ResourceGroup", template([{ ...nested(template([])), ResourceGroup: "rg-prod" }]), "outside-scope"],
    ["SubscriptionId", template([{ ...nested(template([])), SubscriptionId: "00000000-0000-0000-0000-000000000000" }]), "outside-scope"],
    ["Scope", template({ x: { type: "Microsoft.Storage/storageAccounts", apiVersion: "2023-05-01", name: "x", Scope: "/" } }, { languageVersion: "2.0" }), "outside-scope"],
    ["Properties.TemplateLink", template([{ type: "Microsoft.Resources/deployments", apiVersion: "2025-04-01", name: "x", Properties: { mode: "Incremental", TemplateLink: { uri: "https://example.com/t.json" } } }]), "outside-scope"],
    ["Extension", template({ g: { type: "Microsoft.Storage/storageAccounts", Extension: "graph", name: "g" } }, { languageVersion: "2.0" }), "role"],
    ["Extensions", template([], { languageVersion: "2.0", Extensions: { graph: { name: "MicrosoftGraph", version: "1.0.0" } } }), "role"],
    ["$Schema", { ...template([]), $schema: undefined, $Schema: "https://schema.management.azure.com/schemas/2018-05-01/subscriptionDeploymentTemplate.json#" }, "outside-scope"],
    // Two keys ARM would read as one: which one it takes is not this check's to guess.
    ["type and Type", template([{ type: "Microsoft.Storage/storageAccounts", Type: "Microsoft.Authorization/roleAssignments", apiVersion: "2023-05-01", name: "x" }]), "outside-scope"],
  ];
  for (const [what, t, rule] of cases) {
    assert.ok(rules(templateProblems(t)).includes(rule), `${what}: ${JSON.stringify(templateProblems(t))}`);
    assert.equal(checkPlan(tplPlan(JSON.stringify(t)), TPL_LAB).length, 1, `${what} (plan)`);
  }
  // Values keep their meaning: a resource name or tag in capitals is just a name.
  assert.deepEqual(templateProblems(template([{ Type: "Microsoft.Storage/storageAccounts", ApiVersion: "2023-05-01", Name: "LabSA", Location: "uksouth", Kind: "StorageV2", Sku: { Name: "Standard_LRS" }, Tags: { Owner: "Lab" } }])), []);
});

test("templateProblems allows only the resource types on its allow-list, and Bicep's own modules", () => {
  // Lab 12's real template, as the pinned Bicep builds it, and the storage-and-VNet fixture pass.
  assert.deepEqual(templateProblems(LAB12_TEMPLATE), []);
  assert.deepEqual(templateProblems(BICEP_BUILT), []);
  // The allowed types, by full type and as a child declared inside its parent (short type), pass.
  const vnet = { type: "Microsoft.Network/virtualNetworks", apiVersion: "2024-05-01", name: "vnet-bicep", location: "uksouth", properties: { addressSpace: { addressPrefixes: ["[parameters('cidr')]"] } }, resources: [{ type: "subnets", apiVersion: "2024-05-01", name: "snet-a", dependsOn: ["vnet-bicep"], properties: { addressPrefix: "[parameters('cidr')]" } }] };
  const allowed = template([
    vnet,
    { type: "Microsoft.Network/virtualNetworks/subnets", apiVersion: "2024-05-01", name: "vnet-bicep/snet-b", properties: { addressPrefix: "[parameters('cidr')]", networkSecurityGroup: { id: "[resourceId('Microsoft.Network/networkSecurityGroups', 'nsg-bicep')]" } } },
    { type: "Microsoft.Network/networkSecurityGroups", apiVersion: "2024-05-01", name: "nsg-bicep", location: "[resourceGroup().location]" },
    { type: "Microsoft.Network/networkSecurityGroups/securityRules", apiVersion: "2024-05-01", name: "nsg-bicep/allow-https", properties: { priority: 100, direction: "Inbound", access: "Allow", protocol: "Tcp", sourceAddressPrefix: "VirtualNetwork", sourcePortRange: "*", destinationAddressPrefix: "VirtualNetwork", destinationPortRange: "443" } },
    { type: "Microsoft.Storage/storageAccounts", apiVersion: "2023-05-01", name: "labsa", location: "uksouth", kind: "StorageV2", sku: { name: "Standard_LRS" } },
  ], { parameters: { cidr: { type: "string" } } });
  assert.deepEqual(templateProblems(allowed), []);

  const typeCases = [
    // AKS makes its node group (MC_...) outside the lab unless nodeResourceGroup names one; here it does not.
    ["AKS without nodeResourceGroup", template([{ type: "Microsoft.ContainerService/managedClusters", apiVersion: "2024-09-01", name: "aks", location: "uksouth", identity: { type: "SystemAssigned" }, properties: { dnsPrefix: "lab", agentPoolProfiles: [{ name: "np", count: 1, vmSize: "Standard_B2s", mode: "System" }] } }])],
    // An environment in a subnet makes an infrastructure group (ME_...) outside the lab.
    ["Container Apps environment with an infrastructure subnet", template([{ type: "Microsoft.App/managedEnvironments", apiVersion: "2024-03-01", name: "env", location: "uksouth", properties: { vnetConfiguration: { infrastructureSubnetId: "[resourceId('Microsoft.Network/virtualNetworks/subnets', 'vnet-bicep', 'snet-apps')]" } } }])],
    // A managed application's resources live in a managed group of its own.
    ["managed application", template([{ type: "Microsoft.Solutions/applications", apiVersion: "2021-07-01", name: "app", location: "uksouth", kind: "ServiceCatalog", properties: { managedResourceGroupId: "[parameters('mrg')]" } }], { parameters: { mrg: { type: "string" } } })],
    // A deployment stack deploys (and deny-assigns) at any scope it is given.
    ["deployment stack", template([{ type: "Microsoft.Resources/deploymentStacks", apiVersion: "2024-03-01", name: "stack", properties: { actionOnUnmanage: { resources: "delete" }, denySettings: { mode: "none" }, template: template([]) } }])],
    ["a child of an allowed type that is not on the list", template([{ type: "Microsoft.Storage/storageAccounts/blobServices", apiVersion: "2023-05-01", name: "labsa/default" }])],
  ];
  for (const [what, t] of typeCases) {
    const p = templateProblems(t);
    assert.ok(rules(p).includes("outside-scope"), `${what}: ${JSON.stringify(p)}`);
    // The refusal says what to do about it.
    assert.ok(p.some((x) => /allow-list/.test(x.message) && /TEMPLATE_TYPES in infra\/ci\/lab-scope\.mjs/.test(x.message) && /reason/.test(x.message)), `${what}: ${JSON.stringify(p)}`);
    assert.deepEqual(verdict(checkPlan(tplPlan(JSON.stringify(t)), TPL_LAB)), [["outside-scope", TPL_ADDRESS]], `${what} (plan)`);
  }

  // Microsoft.Resources/deployments only as Bicep emits a module: same group, inline template, inner scope, Incremental.
  const module = nested(template([]));
  assert.deepEqual(templateProblems(template([module])), []);
  for (const [what, t] of [
    ["outer expression scope", template([{ ...module, properties: { mode: "Incremental", template: template([]) } }])],
    ["Complete mode", template([{ ...module, properties: { ...module.properties, mode: "Complete" } }])],
    ["a template given as text", template([{ ...module, properties: { ...module.properties, template: JSON.stringify(template([])) } }])],
  ]) {
    assert.ok(rules(templateProblems(t)).includes("outside-scope"), `${what}: ${JSON.stringify(templateProblems(t))}`);
  }

  // Expressions and values that reach above the group.
  const sa = (x) => template([{ type: "Microsoft.Storage/storageAccounts", apiVersion: "2023-05-01", name: "labsa", location: "uksouth", kind: "StorageV2", sku: { name: "Standard_LRS" }, tags: { x } }], { parameters: { rest: { type: "string", defaultValue: "rg-prod" } } });
  for (const [what, x] of [
    ["concat and subscription()", "[concat(subscription().id, '/resourceGroups/', parameters('rest'))]"],
    ["format and subscription()", "[format('{0}{1}', subscription().id, parameters('rest'))]"],
    ["subscription() in capitals", "[SUBSCRIPTION().subscriptionId]"],
    ["tenant()", "[tenant().tenantId]"],
    ["managementGroup()", "[managementGroup().id]"],
    ["resourceId() with a subscription and group", "[resourceId(parameters('rest'), 'rg-prod', 'Microsoft.Network/virtualNetworks', 'vnet-prod')]"],
    ["extensionResourceId()", "[extensionResourceId(parameters('rest'), 'Microsoft.Network/virtualNetworks', 'vnet-prod')]"],
    ["a literal /resourceGroups/ inside a value", "prod lives in x/resourceGroups/rg-prod"],
    ["a literal /subscriptions/ split across literals", "[concat('/subscr', 'iptions/x/resource', 'Groups/rg-prod')]"],
  ]) {
    assert.ok(rules(templateProblems(sa(x))).includes("outside-scope"), `${what}: ${JSON.stringify(templateProblems(sa(x)))}`);
  }
  // resourceGroup() is the deployment's own group: lab 12 takes its location from it.
  assert.deepEqual(templateProblems(sa("[resourceGroup().location]")), []);
});

test("templateProblems refuses a subscription deployment schema", () => {
  for (const scope of ["subscriptionDeploymentTemplate", "managementGroupDeploymentTemplate", "tenantDeploymentTemplate"]) {
    const t = { ...template([]), $schema: `https://schema.management.azure.com/schemas/2018-05-01/${scope}.json#` };
    assert.deepEqual(rules(templateProblems(t)), ["outside-scope"], scope);
    // Nested inside an otherwise resource-group template.
    assert.deepEqual(rules(templateProblems(template([nested(t)]))), ["outside-scope"], `nested ${scope}`);
  }
  assert.deepEqual(rules(templateProblems({ resources: [] })), ["outside-scope"], "no $schema");
  // And anything that is not a template at all.
  for (const t of [null, "not json", 42, []]) assert.deepEqual(rules(templateProblems(t)), ["outside-scope"], JSON.stringify(t));
});

test("a template deployment refuses Graph extension resources, deployment scripts, linked templates and template specs", () => {
  const graphGroup = { type: "Microsoft.Graph/groups@v1.0", extension: "graph", name: "g", properties: { displayName: "lab-x", mailEnabled: false, mailNickname: "x", securityEnabled: true, uniqueName: "x" } };
  const cases = [
    // Entra through the Graph extension (Bicep `extension microsoftGraphV1`), and the older `import` form.
    ["Graph extension", template({ g: graphGroup }, { languageVersion: "2.0", extensions: { graph: { name: "MicrosoftGraph", version: "1.0.0" } } }), "role"],
    ["Graph import", template({ g: { ...graphGroup, extension: undefined, import: "graph" } }, { languageVersion: "2.0", imports: { graph: { provider: "MicrosoftGraph", version: "1.0.0" } } }), "role"],
    ["Graph type alone", template([{ type: "Microsoft.Graph/applications@v1.0", name: "a", properties: {} }]), "role"],
    ["extensions alone", template([], { languageVersion: "2.0", extensions: { k8s: { name: "Kubernetes", version: "1.0.0" } } }), "role"],
    // Access, locks and governance belong in Terraform, where the role rules see them.
    ["role assignment", template([{ type: "Microsoft.Authorization/roleAssignments", apiVersion: "2022-04-01", name: "x" }]), "role"],
    ["lock", template([{ type: "Microsoft.Authorization/locks", apiVersion: "2020-05-01", name: "x" }]), "role"],
    ["old-style extension resource", template([{ type: "Microsoft.Storage/storageAccounts/providers/roleAssignments", apiVersion: "2022-04-01", name: "sa/Microsoft.Authorization/x" }]), "role"],
    ["management group", template([{ type: "Microsoft.Management/managementGroups", apiVersion: "2021-04-01", name: "x" }]), "role"],
    // Code that runs in Azure with an identity of its own.
    ["deployment script", template([{ type: "Microsoft.Resources/deploymentScripts", apiVersion: "2023-08-01", name: "x", kind: "AzureCLI", properties: { scriptContent: "az group list" } }]), "outside-scope"],
    // Templates fetched from elsewhere: a URL or a template spec.
    ["linked template", template([{ type: "Microsoft.Resources/deployments", apiVersion: "2025-04-01", name: "x", properties: { mode: "Incremental", templateLink: { uri: "https://example.com/t.json" } } }]), "outside-scope"],
    ["template spec", template([{ type: "Microsoft.Resources/deployments", apiVersion: "2025-04-01", name: "x", properties: { mode: "Incremental", templateLink: { id: "/subscriptions/3f2b7c1e-5a4d-4e8f-9b6a-2c1d0e9f8a7b/resourceGroups/rg-specs/providers/Microsoft.Resources/templateSpecs/t/versions/1" } } }]), "outside-scope"],
    ["linked parameters", template([nested(template([]), { parametersLink: { uri: "https://example.com/p.json" } })]), "outside-scope"],
    ["template spec resource", template([{ type: "Microsoft.Resources/templateSpecs", apiVersion: "2022-02-01", name: "t" }]), "outside-scope"],
    // Other groups, subscriptions and scopes.
    ["resource group", template([{ type: "Microsoft.Resources/resourceGroups", apiVersion: "2022-09-01", name: "rg-other", location: "uksouth" }]), "outside-scope"],
    ["nested to another group", template([nested(template([]), {}), { ...nested(template([])), name: "n2", resourceGroup: "rg-prod" }]), "outside-scope"],
    ["nested to another subscription", template([{ ...nested(template([])), subscriptionId: "00000000-0000-0000-0000-000000000000" }]), "outside-scope"],
    ["symbolic resource at tenant scope", template({ x: { type: "Microsoft.Storage/storageAccounts", apiVersion: "2023-05-01", name: "x", scope: "/" } }, { languageVersion: "2.0" }), "outside-scope"],
    ["an id in another group", template([{ type: "Microsoft.Network/virtualNetworks/virtualNetworkPeerings", apiVersion: "2024-05-01", name: "vnet-lab/to-prod", properties: { remoteVirtualNetwork: { id: "/subscriptions/3f2b7c1e-5a4d-4e8f-9b6a-2c1d0e9f8a7b/resourceGroups/rg-prod/providers/Microsoft.Network/virtualNetworks/vnet-prod" } } }]), "outside-scope"],
    ["resourceId in another group", template([{ type: "Microsoft.Network/virtualNetworks/virtualNetworkPeerings", apiVersion: "2024-05-01", name: "vnet-lab/to-prod", properties: { remoteVirtualNetwork: { id: "[resourceId('rg-prod', 'Microsoft.Network/virtualNetworks', 'vnet-prod')]" } } }]), "outside-scope"],
    ["subscription-level id", template([{ type: "Microsoft.Storage/storageAccounts", apiVersion: "2023-05-01", name: "x", properties: { x: "[subscriptionResourceId('Microsoft.Resources/resourceGroups', 'rg-prod')]" } }]), "outside-scope"],
    ["Graph deep inside a module", template([nested(template([nested(template([{ type: "Microsoft.Graph/users@v1.0", name: "u" }]))]))]), "role"],
    // A property called "template" that is not a nested deployment's is read like any other.
    ["an id inside a container app's template", template([{ type: "Microsoft.App/containerApps", apiVersion: "2025-01-01", name: "app", properties: { template: { containers: [{ name: "c", image: "mcr.microsoft.com/k8se/quickstart:latest", env: [{ name: "VNET", value: "/subscriptions/3f2b7c1e-5a4d-4e8f-9b6a-2c1d0e9f8a7b/resourceGroups/rg-prod/providers/Microsoft.Network/virtualNetworks/vnet-prod" }] }] } } }]), "outside-scope"],
    ["the gateway inside a resource's properties.metadata", template([{ type: "Microsoft.Storage/storageAccounts", apiVersion: "2023-05-01", name: "x", properties: { metadata: { peer: "vnet-wg" } } }]), "gateway"],
    // The gateway's names, as anywhere else.
    ["gateway", template([{ type: "Microsoft.Network/virtualNetworks/virtualNetworkPeerings", apiVersion: "2024-05-01", name: "vnet-lab/to-wg", properties: { remoteVirtualNetwork: { id: "[resourceId('Microsoft.Network/virtualNetworks', 'vnet-wg')]" } } }]), "gateway"],
  ];
  for (const [what, t, rule] of cases) {
    assert.ok(rules(templateProblems(t)).includes(rule), `${what}: ${JSON.stringify(templateProblems(t))}`);
    // In a plan and in HCL, the deployment is refused under the template's first rule.
    const [first] = verdict(checkPlan(tplPlan(JSON.stringify(t)), TPL_LAB));
    assert.deepEqual(first, [rules(templateProblems(t)).sort((a, b) => RULES.indexOf(a) - RULES.indexOf(b))[0], TPL_ADDRESS], `${what} (plan)`);
    assert.equal(checkHcl(tplHcl(JSON.stringify(t)), TPL_LAB).length, 1, `${what} (hcl)`);
  }
  // template_spec_version_id deploys a spec this check never sees.
  const spec = { template_spec_version_id: "/subscriptions/3f2b7c1e-5a4d-4e8f-9b6a-2c1d0e9f8a7b/resourceGroups/rg-lab-az104-12-bicep/providers/Microsoft.Resources/templateSpecs/t/versions/1" };
  assert.deepEqual(verdict(checkHcl(tplHcl(undefined, spec), TPL_LAB)), [["outside-scope", TPL_ADDRESS]]);
  assert.deepEqual(verdict(checkPlan(tplPlan(undefined, spec), TPL_LAB)), [["outside-scope", TPL_ADDRESS]]);
  // Deployments at other scopes, and deployment scripts written in Terraform.
  const other = (type, body) => ({ resource: { azurerm_resource_group: { lab: [{ name: "${var.resource_group_name}", location: "${var.region}" }] }, [type]: { x: [body] } } });
  for (const [type, body] of [
    ["azurerm_subscription_template_deployment", { name: "x", location: "uksouth", template_content: JSON.stringify(template([])) }],
    ["azurerm_management_group_template_deployment", { name: "x", location: "uksouth", management_group_id: "/providers/Microsoft.Management/managementGroups/lab-az104-12-bicep-x", template_content: JSON.stringify(template([])) }],
    ["azurerm_tenant_template_deployment", { name: "x", location: "uksouth", template_content: JSON.stringify(template([])) }],
    ["azurerm_resource_deployment_script_azure_cli", { name: "x", resource_group_name: "${azurerm_resource_group.lab.name}", location: "uksouth", version: "2.60.0", retention_interval: "P1D", script_content: "az group list" }],
    ["azurerm_resource_deployment_script_azure_power_shell", { name: "x", resource_group_name: "${azurerm_resource_group.lab.name}", location: "uksouth", version: "11.0", retention_interval: "P1D", script_content: "Get-AzResourceGroup" }],
  ]) {
    assert.deepEqual(verdict(checkHcl(other(type, body), TPL_LAB)), [["outside-scope", `${type}.x`]], type);
  }
});

test("in a plan, a template deployment whose template_content is unknown is refused; in HCL it is left to labs-tf", () => {
  assert.deepEqual(verdict(checkPlan(tplPlan(null), TPL_LAB)), [["outside-scope", TPL_ADDRESS]]);
  assert.match(checkPlan(tplPlan(null), TPL_LAB)[0].message, /template_content/);
  // HCL: file() of the JSON Bicep builds is not known to this check; labs-tf checks the built JSON with templateProblems.
  const fromFile = tplHcl('${file("${path.module}/main.json")}');
  assert.deepEqual(checkHcl(fromFile, TPL_LAB), []);
  // The mode decides, not the input's shape.
  assert.deepEqual(verdict(scopeProblems(hclResources(fromFile, TPL_LAB), TPL_LAB, { mode: "plan" })), [["outside-scope", TPL_ADDRESS]]);
  assert.deepEqual(scopeProblems(hclResources(fromFile, TPL_LAB), TPL_LAB, { mode: "hcl" }), []);
  assert.deepEqual(scopeProblems(planResources(tplPlan(JSON.stringify(BICEP_BUILT))), TPL_LAB), [], "plan mode is the default");
});

test("a container app environment with an infrastructure subnet must name its infrastructure group rg-lab-<id>-*", () => {
  const id = "az104-11-containers";
  const env = (extra) => ({
    resource: {
      azurerm_resource_group: { lab: [{ name: "${var.resource_group_name}", location: "${var.region}" }] },
      azurerm_subnet: { aca: [{ name: "snet-aca", resource_group_name: "${azurerm_resource_group.lab.name}", virtual_network_name: "vnet-lab", address_prefixes: ["${cidrsubnet(var.address_space, 5, 1)}"] }] },
      azurerm_container_app_environment: { env: [{ name: "cae-lab", resource_group_name: "${azurerm_resource_group.lab.name}", location: "${azurerm_resource_group.lab.location}", ...extra }] },
    },
  });
  // Consumption only, no subnet: Azure makes no group of its own.
  assert.deepEqual(checkHcl(env({}), id), []);
  // A subnet: Azure makes an infrastructure group (ME_...) unless told its name.
  assert.deepEqual(verdict(checkHcl(env({ infrastructure_subnet_id: "${azurerm_subnet.aca.id}" }), id)), [["azure-made-group", "azurerm_container_app_environment.env"]]);
  assert.deepEqual(verdict(checkHcl(env({ infrastructure_subnet_id: "${azurerm_subnet.aca.id}", infrastructure_resource_group_name: "ME_cae-lab" }), id)), [["azure-made-group", "azurerm_container_app_environment.env"]]);
  assert.deepEqual(checkHcl(env({ infrastructure_subnet_id: "${azurerm_subnet.aca.id}", infrastructure_resource_group_name: "${var.resource_group_name}-cae", workload_profile: [{ name: "Consumption", workload_profile_type: "Consumption" }] }), id), []);
  // In a plan: the subnet id is unknown (configured), and the group's name must be known and the lab's.
  const rg = `rg-lab-${id}`;
  const plan = (values) =>
    realisticPlan({
      resources: [
        { address: "azurerm_resource_group.lab", values: { name: rg, location: "uksouth" }, refs: { name: ["var.resource_group_name"] } },
        { address: "azurerm_subnet.aca", values: { name: "snet-aca", resource_group_name: rg, virtual_network_name: "vnet-lab", address_prefixes: ["10.64.64.32/27"] }, refs: { resource_group_name: ["azurerm_resource_group.lab.name", "azurerm_resource_group.lab"] } },
        {
          address: "azurerm_container_app_environment.env",
          values: { name: "cae-lab", resource_group_name: rg, location: "uksouth", ...values },
          unknown: ["infrastructure_subnet_id"],
          refs: { resource_group_name: ["azurerm_resource_group.lab.name", "azurerm_resource_group.lab"], infrastructure_subnet_id: ["azurerm_subnet.aca.id", "azurerm_subnet.aca"] },
        },
      ],
    });
  assert.deepEqual(verdict(checkPlan(plan({}), id)), [["azure-made-group", "azurerm_container_app_environment.env"]]);
  assert.deepEqual(checkPlan(plan({ infrastructure_resource_group_name: `${rg}-cae` }), id), []);
});

// count and for_each: lab 16's real plan was refused because a VM's
// network_interface_ids = [azurerm_network_interface.web[count.index].id]
// lists count.index among its references. Terraform 1.14.6 prints that
// reference as ["azurerm_network_interface.web", "count.index"] (checked with
// a real `terraform show -json`); older notes give the long form too.
const LB_LAB = "az104-16-lb-appgw";
const LB_RG = `rg-lab-${LB_LAB}`;
const IN_LB_RG = { resource_group_name: ["azurerm_resource_group.lab.name", "azurerm_resource_group.lab"] };
/** NICs (count 2 or for_each), VMs on them and pool members, with the VM's and member's NIC references as given. */
function repeatPlan({ nicRefs, memberRefs = nicRefs, repeat = "count", vmForEach, data = [] }) {
  const keys = repeat === "count" ? ["[0]", "[1]"] : ['["a"]', '["b"]'];
  const each = repeat === "count" ? { count: 2 } : { forEach: { constant_value: { a: "vm-web1", b: "vm-web2" } } };
  const vmEach = repeat === "count" ? { count: 2 } : { forEach: vmForEach ?? { references: ["azurerm_network_interface.web"] } };
  return realisticPlan({
    resources: [
      { address: "azurerm_resource_group.lab", values: { name: LB_RG, location: "uksouth" }, refs: { name: ["var.resource_group_name"] } },
      { address: "azurerm_lb.web", values: { name: "lbi-web", resource_group_name: LB_RG, location: "uksouth", sku: "Standard" }, refs: IN_LB_RG },
      { address: "azurerm_lb_backend_address_pool.web", values: { name: "pool-web" }, unknown: ["loadbalancer_id"], refs: { loadbalancer_id: ["azurerm_lb.web.id", "azurerm_lb.web"] } },
      ...keys.flatMap((k, i) => [
        { address: `azurerm_network_interface.web${k}`, ...each, values: { name: `nic-vm-web${i + 1}`, resource_group_name: LB_RG, location: "uksouth", ip_configuration: [{ name: "ipconfig1", private_ip_address_allocation: "Dynamic" }] }, refs: { ...IN_LB_RG, name: [repeat === "count" ? "count.index" : "each.value"] } },
        { address: `azurerm_linux_virtual_machine.web${k}`, ...vmEach, values: { name: `vm-web${i + 1}`, resource_group_name: LB_RG, location: "uksouth", size: "Standard_B1s", admin_username: "azureuser" }, unknown: ["network_interface_ids"], refs: { ...IN_LB_RG, name: [repeat === "count" ? "count.index" : "each.key"], network_interface_ids: nicRefs } },
        { address: `azurerm_network_interface_backend_address_pool_association.web${k}`, ...vmEach, values: { ip_configuration_name: "ipconfig1" }, unknown: ["network_interface_id", "backend_address_pool_id"], refs: { network_interface_id: memberRefs, backend_address_pool_id: ["azurerm_lb_backend_address_pool.web.id", "azurerm_lb_backend_address_pool.web"] } },
      ]),
    ],
    data,
  });
}

test("count.index and each.key next to a lab resource's reference stay inside the lab (lab 16's VMs and pool members)", () => {
  // As Terraform 1.14.6 prints azurerm_network_interface.web[count.index].id.
  assert.deepEqual(checkPlan(repeatPlan({ nicRefs: ["azurerm_network_interface.web", "count.index"] }), LB_LAB), []);
  // The long form, with the key spelled inside the reference.
  const long = ["azurerm_network_interface.web[count.index].id", "azurerm_network_interface.web[count.index]", "azurerm_network_interface.web", "count.index"];
  assert.deepEqual(checkPlan(repeatPlan({ nicRefs: long }), LB_LAB), []);
  // for_each over a constant map, the VMs over the NICs: azurerm_network_interface.web[each.key].id ...
  assert.deepEqual(checkPlan(repeatPlan({ repeat: "for_each", nicRefs: ["azurerm_network_interface.web", "each.key"] }), LB_LAB), []);
  assert.deepEqual(checkPlan(repeatPlan({ repeat: "for_each", nicRefs: ["azurerm_network_interface.web[each.key].id", "azurerm_network_interface.web[each.key]", "azurerm_network_interface.web", "each.key"] }), LB_LAB), []);
  // ... and each.value.id, when for_each ranges over the lab's own NICs.
  assert.deepEqual(checkPlan(repeatPlan({ repeat: "for_each", nicRefs: ["each.value.id", "each.value"] }), LB_LAB), []);
});

test("count.index or each.* alone, or next to something outside the lab, is still refused", () => {
  const refused = (plan) => verdict(checkPlan(plan, LB_LAB));
  const vmsAndMembers = [
    ["outside-scope", "azurerm_linux_virtual_machine.web"],
    ["outside-scope", "azurerm_linux_virtual_machine.web"],
    ["outside-scope", "azurerm_network_interface_backend_address_pool_association.web"],
    ["outside-scope", "azurerm_network_interface_backend_address_pool_association.web"],
  ];
  // Only count.index: nothing places the value.
  assert.deepEqual(refused(repeatPlan({ nicRefs: ["count.index"] })), vmsAndMembers);
  const only = checkPlan(repeatPlan({ nicRefs: ["count.index"] }), LB_LAB);
  assert.match(only[0].message, /comes from count\.index/);
  // count.index and a variable or a data source the lab does not make.
  assert.deepEqual(refused(repeatPlan({ nicRefs: ["var.nic_ids", "count.index"] })), vmsAndMembers);
  const other = { address: "data.azurerm_subscription.other", values: { subscription_id: "3f2b7c1e-5a4d-4e8f-9b6a-2c1d0e9f8a7b" } };
  const dataPlan = repeatPlan({ nicRefs: ["data.azurerm_subscription.other.id", "data.azurerm_subscription.other", "count.index"], data: [other] });
  assert.deepEqual(refused(dataPlan), vmsAndMembers);
  // Only each.key: nothing places it either.
  assert.deepEqual(refused(repeatPlan({ repeat: "for_each", nicRefs: ["each.key"] })), vmsAndMembers);
  // each.value when for_each ranges over a variable (or a local) this check cannot see into.
  assert.deepEqual(refused(repeatPlan({ repeat: "for_each", nicRefs: ["each.value.id", "each.value"], vmForEach: { references: ["var.nics"] } })), vmsAndMembers);
  assert.deepEqual(refused(repeatPlan({ repeat: "for_each", nicRefs: ["azurerm_lb.web", "each.value"], vmForEach: { references: ["local.nics"] } })), vmsAndMembers);
  // each.value over a constant naming another group's NIC.
  const outsideId = "/subscriptions/3f2b7c1e-5a4d-4e8f-9b6a-2c1d0e9f8a7b/resourceGroups/rg-elsewhere/providers/Microsoft.Network/networkInterfaces/nic-x";
  assert.deepEqual(refused(repeatPlan({ repeat: "for_each", nicRefs: ["azurerm_lb.web", "each.value"], vmForEach: { constant_value: { a: outsideId } } })), vmsAndMembers);
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

// ── Batch 3 (labs batch 3 plan, C0.3; spec §17 rulings 25, 28-31) ────────

const SUB_ID = "/subscriptions/3f2b7c1e-5a4d-4e8f-9b6a-2c1d0e9f8a7b";
const MONITORING_CONTRIBUTOR = "749f88d5-cbae-40b8-bcfc-e573ddc772fa";
const OWNER = "8e3af657-a8ff-443c-a75c-2fe8c4bcb635";
const LOG_ANALYTICS_CONTRIBUTOR = "92aaf0da-9dab-42b6-94a3-d43ce8d16293";
const RG_HCL = { lab: [{ name: "${var.resource_group_name}", location: "${var.region}" }] };

test("a management-group initiative is a governance definition", () => {
  const set = (name) => ({
    resource: {
      azurerm_resource_group: RG_HCL,
      azurerm_management_group: { root: [{ name: "lab-${var.lab_id}-root", display_name: "lab-${var.lab_id}-root" }] },
      azurerm_management_group_policy_set_definition: { baseline: [{ name, display_name: name, policy_type: "Custom", management_group_id: "${azurerm_management_group.root.id}", policy_definition_reference: [{ policy_definition_id: "/providers/Microsoft.Authorization/policyDefinitions/e56962a6-4747-49cd-b67b-bf8b01975c4c" }] }] },
    },
  });
  assert.deepEqual(checkHcl(set("lab-${var.lab_id}-baseline"), "az305-20-landing-zone"), []);
  // Only for the governance labs, and only named lab-<id>-.
  assert.deepEqual(verdict(checkHcl(set("lab-${var.lab_id}-baseline"), "az305-22-keyvault-mi")), [["governance", "azurerm_management_group.root"], ["governance", "azurerm_management_group_policy_set_definition.baseline"]]);
  assert.deepEqual(verdict(checkHcl(set("baseline"), "az305-20-landing-zone")), [["governance", "azurerm_management_group_policy_set_definition.baseline"]]);
  // At a management group the lab does not own.
  const other = set("lab-${var.lab_id}-baseline");
  other.resource.azurerm_management_group_policy_set_definition.baseline[0].management_group_id = "/providers/Microsoft.Management/managementGroups/corp";
  assert.deepEqual(verdict(checkHcl(other, "az305-20-landing-zone")), [["outside-scope", "azurerm_management_group_policy_set_definition.baseline"]]);
});

test("a Key Vault with purge protection is refused", () => {
  const id = "az305-22-keyvault-mi";
  const kv = (extra) => ({ resource: { azurerm_resource_group: RG_HCL, azurerm_key_vault: { kv: [{ name: "${var.name_prefix}kv", resource_group_name: "${azurerm_resource_group.lab.name}", location: "${azurerm_resource_group.lab.location}", sku_name: "standard", tenant_id: "${data.azurerm_client_config.current.tenant_id}", soft_delete_retention_days: 7, ...extra }] } }, data: { azurerm_client_config: { current: [{}] } } });
  assert.deepEqual(checkHcl(kv({}), id), []);
  assert.deepEqual(checkHcl(kv({ purge_protection_enabled: false }), id), []);
  assert.deepEqual(verdict(checkHcl(kv({ purge_protection_enabled: true }), id)), [["immutability", "azurerm_key_vault.kv"]]);
  assert.match(checkHcl(kv({ purge_protection_enabled: true }), id)[0].message, /purge protection/);
  // Set from something this check cannot know: refused too.
  assert.deepEqual(verdict(checkHcl(kv({ purge_protection_enabled: "${var.peered}" }), id)), [["immutability", "azurerm_key_vault.kv"]]);
  // In a plan: known true refused; unknown because configured refused; false passes.
  const c = ctx(id, "22");
  const plan = (values, unknown = []) =>
    realisticPlan({
      resources: [rgResource(c), { address: "azurerm_key_vault.kv", values: { name: `${c.prefix}kv`, resource_group_name: c.rg, location: "uksouth", sku_name: "standard", tenant_id: "x", soft_delete_retention_days: 7, ...values }, unknown, refs: { resource_group_name: ["azurerm_resource_group.lab.name", "azurerm_resource_group.lab"], ...(unknown.length ? { purge_protection_enabled: ["azurerm_resource_group.lab.id", "azurerm_resource_group.lab"] } : {}) } }],
    });
  assert.deepEqual(checkPlan(plan({ purge_protection_enabled: false }), id), []);
  assert.deepEqual(verdict(checkPlan(plan({ purge_protection_enabled: true }), id)), [["immutability", "azurerm_key_vault.kv"]]);
  assert.deepEqual(verdict(checkPlan(plan({}, ["purge_protection_enabled"]), id)), [["immutability", "azurerm_key_vault.kv"]]);
});

/** A lab policy definition whose rule deploys (DINE) with these role ids, at this deployment scope. */
const dineRule = (roleIds, deploymentScope) => ({
  if: { field: "type", equals: "Microsoft.KeyVault/vaults" },
  then: {
    effect: "deployIfNotExists",
    details: {
      type: "Microsoft.Insights/diagnosticSettings",
      roleDefinitionIds: roleIds.map((g) => `/providers/Microsoft.Authorization/roleDefinitions/${g}`),
      ...(deploymentScope ? { deploymentScope } : {}),
      deployment: { properties: { mode: "incremental", template: { $schema: RG_SCHEMA, resources: [] } } },
    },
  },
});
const dineHcl = (rule) => ({
  resource: {
    azurerm_resource_group: RG_HCL,
    azurerm_policy_definition: { kv: [{ name: "lab-${var.lab_id}-kv-diagnostics", display_name: "lab-${var.lab_id}-kv-diagnostics", policy_type: "Custom", mode: "Indexed", policy_rule: JSON.stringify(rule) }] },
  },
});

test("a DINE definition with Monitoring Contributor only passes for a governance lab", () => {
  const id = "az305-21-monitoring-scale";
  assert.deepEqual(checkHcl(dineHcl(dineRule([MONITORING_CONTRIBUTOR])), id), []);
  // A modify effect is held to the same rule.
  const modify = dineRule([MONITORING_CONTRIBUTOR]);
  modify.then.effect = "Modify";
  modify.then.details = { roleDefinitionIds: modify.then.details.roleDefinitionIds, operations: [] };
  assert.deepEqual(checkHcl(dineHcl(modify), id), []);
  // Not a governance lab: no policy definitions at all.
  assert.deepEqual(verdict(checkHcl(dineHcl(dineRule([MONITORING_CONTRIBUTOR])), "az305-22-keyvault-mi")), [["governance", "azurerm_policy_definition.kv"]]);
});

test("a remediating policy may list only allow-listed roles and never deploy at subscription scope", () => {
  const id = "az305-21-monitoring-scale";
  // Owner, a built-in not on the allow-list (Log Analytics Contributor: identity change 1 if it is ever needed), or a lab custom role.
  for (const roles of [[OWNER], [MONITORING_CONTRIBUTOR, LOG_ANALYTICS_CONTRIBUTOR], ["7331dcae-09d3-477e-8da7-2895697f0fc0"]]) {
    const r = checkHcl(dineHcl(dineRule(roles)), id);
    assert.deepEqual(verdict(r), [["role", "azurerm_policy_definition.kv"]], roles.join());
    assert.match(r[0].message, /roleDefinitionIds/);
  }
  // An effect given as a parameter still has its roleDefinitionIds read.
  const param = dineRule([OWNER]);
  param.then.effect = "[parameters('effect')]";
  assert.deepEqual(verdict(checkHcl(dineHcl(param), id)), [["role", "azurerm_policy_definition.kv"]]);
  // A deployment at subscription scope, however its roles look.
  const sub = checkHcl(dineHcl(dineRule([MONITORING_CONTRIBUTOR], "subscription")), id);
  assert.deepEqual(verdict(sub), [["outside-scope", "azurerm_policy_definition.kv"]]);
  assert.match(sub[0].message, /deploymentScope/);
  assert.deepEqual(checkHcl(dineHcl(dineRule([MONITORING_CONTRIBUTOR], "resourceGroup")), id), []);
  // In a plan, a rule the check cannot read (built from apply-time values) is refused: pass those as assignment parameters.
  const c = ctx(id, "21");
  const plan = (values, unknown = []) => realisticPlan({ resources: [rgResource(c), { address: "azurerm_policy_definition.kv", values: { name: `lab-${id}-kv-diagnostics`, display_name: `lab-${id}-kv-diagnostics`, policy_type: "Custom", mode: "Indexed", ...values }, unknown, refs: { name: ["var.lab_id"], ...(unknown.length ? { policy_rule: ["azurerm_resource_group.lab.id", "azurerm_resource_group.lab"] } : {}) } }] });
  assert.deepEqual(checkPlan(plan({ policy_rule: JSON.stringify(dineRule([MONITORING_CONTRIBUTOR])) }), id), []);
  assert.deepEqual(verdict(checkPlan(plan({ policy_rule: JSON.stringify(dineRule([OWNER])) }), id)), [["role", "azurerm_policy_definition.kv"]]);
  const unread = checkPlan(plan({}, ["policy_rule"]), id);
  assert.deepEqual(verdict(unread), [["role", "azurerm_policy_definition.kv"]]);
  assert.match(unread[0].message, /not known at plan/);
  // An audit rule (lab 2's) has no roles and needs none.
  assert.deepEqual(checkPlan(LAB_PLANS["az104-02-policy"].plan, "az104-02-policy"), []);
});

test("rg-lab-<id>-secondary is the lab's and rg-lab-<id>secondary is not", () => {
  const id = "az305-23-sql-failover";
  const groups = (secondaryName) => ({
    resource: {
      azurerm_resource_group: { lab: RG_HCL.lab, secondary: [{ name: secondaryName, location: "${var.secondary_region}" }] },
      azurerm_mssql_server: { s: [{ name: "${var.name_prefix}-sqls", resource_group_name: "${azurerm_resource_group.secondary.name}", location: "${azurerm_resource_group.secondary.location}", version: "12.0" }] },
    },
  });
  assert.deepEqual(checkHcl(groups("${var.resource_group_name}-secondary"), id), []);
  assert.deepEqual(verdict(checkHcl(groups("${var.resource_group_name}secondary"), id)), [["resource-group", "azurerm_resource_group.secondary"]]);
  // A resource naming rg-lab-<id>secondary outright.
  const named = groups("${var.resource_group_name}-secondary");
  named.resource.azurerm_mssql_server.s[0].resource_group_name = `rg-lab-${id}secondary`;
  assert.deepEqual(verdict(checkHcl(named, id)), [["outside-scope", "azurerm_mssql_server.s"]]);
  // In a plan.
  const c = ctx(id, "23");
  assert.deepEqual(checkPlan(realisticPlan({ resources: [rgResource(c), rgSecondaryResource(c)] }), id), []);
  const bad = rgSecondaryResource(c);
  bad.values.name = `${c.rg}secondary`;
  assert.deepEqual(verdict(checkPlan(realisticPlan({ resources: [rgResource(c), bad] }), id)), [["resource-group", "azurerm_resource_group.secondary"]]);
});

test("a Site Recovery target group outside the lab is refused", () => {
  const id = "az305-26-site-recovery";
  const c = ctx(id, "26");
  const IN2 = { resource_group_name: ["azurerm_resource_group.secondary.name", "azurerm_resource_group.secondary"] };
  const replicated = ({ target, disk }) => ({
    address: "azurerm_site_recovery_replicated_vm.vm",
    values: { name: "vm-app", resource_group_name: c.rgSecondary, recovery_vault_name: "rsv-lab", source_recovery_fabric_name: "fabric-uksouth", managed_disk: [{ target_disk_type: "Standard_LRS", target_replica_disk_type: "Standard_LRS", ...(disk.known ? { target_resource_group_id: disk.known } : {}) }], ...(target.known ? { target_resource_group_id: target.known } : {}) },
    unknown: ["source_vm_id", "managed_disk.0.staging_storage_account_id", "managed_disk.0.disk_id", ...(target.refs ? ["target_resource_group_id"] : []), ...(disk.refs ? ["managed_disk.0.target_resource_group_id"] : [])],
    refs: {
      ...IN2,
      source_vm_id: ["azurerm_linux_virtual_machine.vm.id", "azurerm_linux_virtual_machine.vm"],
      "managed_disk.0.staging_storage_account_id": ["azurerm_storage_account.cache.id", "azurerm_storage_account.cache"],
      "managed_disk.0.disk_id": ["azurerm_linux_virtual_machine.vm.os_disk[0].id", "azurerm_linux_virtual_machine.vm"],
      ...(target.refs ? { target_resource_group_id: target.refs } : {}),
      ...(disk.refs ? { "managed_disk.0.target_resource_group_id": disk.refs } : {}),
    },
  });
  const IN1 = { resource_group_name: ["azurerm_resource_group.lab.name", "azurerm_resource_group.lab"] };
  const base = [rgResource(c), rgSecondaryResource(c), { address: "azurerm_linux_virtual_machine.vm", values: { name: "vm-app", resource_group_name: c.rg, location: "uksouth" }, refs: IN1 }, { address: "azurerm_storage_account.cache", values: { name: `${c.prefix}cache`, resource_group_name: c.rg, location: "uksouth" }, refs: IN1 }];
  const own = ["azurerm_resource_group.secondary.id", "azurerm_resource_group.secondary"];
  const other = { address: "data.azurerm_resource_group.other", values: { name: "rg-prod" } };
  const plan = (r, data = []) => realisticPlan({ resources: [...base, r], data });
  assert.deepEqual(checkPlan(plan(replicated({ target: { refs: own }, disk: { refs: own } })), id), []);
  // A known id in another group, at the top or inside the disk block.
  const elsewhere = `${SUB_ID}/resourceGroups/rg-prod`;
  assert.deepEqual(verdict(checkPlan(plan(replicated({ target: { known: elsewhere }, disk: { refs: own } })), id)), [["outside-scope", "azurerm_site_recovery_replicated_vm.vm"]]);
  assert.deepEqual(verdict(checkPlan(plan(replicated({ target: { refs: own }, disk: { known: elsewhere } })), id)), [["outside-scope", "azurerm_site_recovery_replicated_vm.vm"]]);
  // From something the lab does not make (a variable, or a data source), even inside a block.
  assert.deepEqual(verdict(checkPlan(plan(replicated({ target: { refs: ["var.target_group_id"] }, disk: { refs: own } })), id)), [["outside-scope", "azurerm_site_recovery_replicated_vm.vm"]]);
  assert.deepEqual(verdict(checkPlan(plan(replicated({ target: { refs: own }, disk: { refs: ["data.azurerm_resource_group.other.id", "data.azurerm_resource_group.other"] } }), [other]), id)), [["outside-scope", "azurerm_site_recovery_replicated_vm.vm"]]);
});

test("a failover group whose partner server is outside the lab is refused", () => {
  const id = "az305-23-sql-failover";
  const fog = (partner) => ({
    resource: {
      azurerm_resource_group: { lab: RG_HCL.lab, secondary: [{ name: "${var.resource_group_name}-secondary", location: "${var.secondary_region}" }] },
      azurerm_mssql_server: {
        p: [{ name: "${var.name_prefix}-sqlp", resource_group_name: "${azurerm_resource_group.lab.name}", location: "${azurerm_resource_group.lab.location}", version: "12.0" }],
        s: [{ name: "${var.name_prefix}-sqls", resource_group_name: "${azurerm_resource_group.secondary.name}", location: "${azurerm_resource_group.secondary.location}", version: "12.0" }],
      },
      azurerm_mssql_failover_group: { fog: [{ name: "${var.name_prefix}-fog", server_id: "${azurerm_mssql_server.p.id}", partner_server: [{ id: partner }], read_write_endpoint_failover_policy: [{ mode: "Manual" }] }] },
    },
  });
  assert.deepEqual(checkHcl(fog("${azurerm_mssql_server.s.id}"), id), []);
  assert.deepEqual(verdict(checkHcl(fog(`${SUB_ID}/resourceGroups/rg-prod/providers/Microsoft.Sql/servers/sql-prod`), id)), [["outside-scope", "azurerm_mssql_failover_group.fog"]]);
  assert.deepEqual(verdict(checkHcl(fog("${var.partner_id}"), id)), [["outside-scope", "azurerm_mssql_failover_group.fog"]]);
  // In a plan the partner's id is unknown: from the lab's own server it passes, from a variable it does not.
  const c = ctx(id, "23");
  const server = (key, rg, group) => ({ address: `azurerm_mssql_server.${key}`, values: { name: `${c.prefix}-sql${key}`, resource_group_name: rg, location: "uksouth", version: "12.0" }, refs: { resource_group_name: [`azurerm_resource_group.${group}.name`, `azurerm_resource_group.${group}`] } });
  const group = (refs) => ({ address: "azurerm_mssql_failover_group.fog", values: { name: `${c.prefix}-fog`, read_write_endpoint_failover_policy: [{ mode: "Manual" }], partner_server: [{}] }, unknown: ["server_id", "partner_server.0.id"], refs: { server_id: ["azurerm_mssql_server.p.id", "azurerm_mssql_server.p"], "partner_server.0.id": refs } });
  const plan = (refs) => realisticPlan({ resources: [rgResource(c), rgSecondaryResource(c), server("p", c.rg, "lab"), server("s", c.rgSecondary, "secondary"), group(refs)] });
  assert.deepEqual(checkPlan(plan(["azurerm_mssql_server.s.id", "azurerm_mssql_server.s"]), id), []);
  assert.deepEqual(verdict(checkPlan(plan(["var.partner_id"]), id)), [["outside-scope", "azurerm_mssql_failover_group.fog"]]);
});

// Real `terraform show -json` (Terraform 1.14.6, checked offline 2026-10-05): only a schema *block* is split in
// configuration.expressions ("partner_server": [{ "id": { references } }]). An *attribute* holding objects or
// lists (azurerm's managed_disk and network_interface, typed set(object); a failover group's databases) has one
// expression with every reference in it, while after_unknown marks the unknown values inside it by their own
// nested paths ("managed_disk.0.target_resource_group_id", "databases.0"). (Lab 23's real plan, 2026-10-06, left
// its databases wholly unknown, "databases": true; both forms are held to the references, below.)
test("an unknown id inside an attribute written as blocks is held to the attribute's own references", () => {
  const id = "az305-26-site-recovery";
  const c = ctx(id, "26");
  const IN1 = { resource_group_name: ["azurerm_resource_group.lab.name", "azurerm_resource_group.lab"] };
  const IN2 = { resource_group_name: ["azurerm_resource_group.secondary.name", "azurerm_resource_group.secondary"] };
  const vm = "azurerm_linux_virtual_machine.vm";
  const OWN_DISK = [`${vm}.os_disk[0].id`, `${vm}.os_disk[0]`, `${vm}.os_disk`, vm, "azurerm_storage_account.cache.id", "azurerm_storage_account.cache", "azurerm_resource_group.secondary.id", "azurerm_resource_group.secondary"];
  const replicated = ({ disk = OWN_DISK, nic = ["azurerm_network_interface.vm.id", "azurerm_network_interface.vm"], diskKnown = {} } = {}) => ({
    address: "azurerm_site_recovery_replicated_vm.vm",
    values: { name: "vm-app", resource_group_name: c.rgSecondary, recovery_vault_name: "rsv-lab", managed_disk: [{ target_disk_type: "Standard_LRS", target_replica_disk_type: "Standard_LRS", ...diskKnown }], network_interface: [{ target_subnet_name: "snet-vms" }] },
    unknown: ["source_vm_id", "managed_disk.0.disk_id", "managed_disk.0.staging_storage_account_id", ...("target_resource_group_id" in diskKnown ? [] : ["managed_disk.0.target_resource_group_id"]), "network_interface.0.source_network_interface_id"],
    refs: { ...IN2, source_vm_id: [`${vm}.id`, vm], managed_disk: disk, network_interface: nic },
  });
  const base = [
    rgResource(c),
    rgSecondaryResource(c),
    { address: vm, values: { name: "vm-app", resource_group_name: c.rg, location: "uksouth" }, refs: IN1 },
    { address: "azurerm_network_interface.vm", values: { name: "nic-app", resource_group_name: c.rg, location: "uksouth" }, refs: IN1 },
    { address: "azurerm_storage_account.cache", values: { name: `${c.prefix}cache`, resource_group_name: c.rg, location: "uksouth" }, refs: IN1 },
  ];
  const other = { address: "data.azurerm_resource_group.other", values: { name: "rg-prod" } };
  const plan = (r, data = []) => realisticPlan({ resources: [...base, r], data });
  // The shape is the real one: references under the attribute, none under the nested path.
  const real = planResources(plan(replicated()));
  const rv = real.resources.find((r) => r.address === "azurerm_site_recovery_replicated_vm.vm");
  assert.ok(rv.refs.managed_disk.includes("azurerm_resource_group.secondary.id"));
  assert.equal(rv.refs["managed_disk.0.target_resource_group_id"], undefined);
  // Every reference the lab's own: passes (count.index, the instance's key, is no reference outside).
  assert.deepEqual(checkPlan(plan(replicated()), id), []);
  assert.deepEqual(checkPlan(plan(replicated({ nic: ["azurerm_network_interface.vm", "count.index"] })), id), []);
  // A variable or a data source outside the lab among the attribute's references: refused.
  assert.deepEqual(verdict(checkPlan(plan(replicated({ disk: [...OWN_DISK.slice(0, 6), "var.target_group_id"] })), id)), [["outside-scope", "azurerm_site_recovery_replicated_vm.vm"]]);
  assert.deepEqual(verdict(checkPlan(plan(replicated({ disk: [...OWN_DISK.slice(0, 6), "data.azurerm_resource_group.other.id", "data.azurerm_resource_group.other"] }), [other]), id)), [["outside-scope", "azurerm_site_recovery_replicated_vm.vm"]]);
  assert.deepEqual(verdict(checkPlan(plan(replicated({ nic: ["var.nic_id"] })), id)), [["outside-scope", "azurerm_site_recovery_replicated_vm.vm"]]);
  const refused = checkPlan(plan(replicated({ nic: ["var.nic_id"] })), id)[0];
  assert.match(refused.message, /network_interface\.0\.source_network_interface_id comes from var\.nic_id/);
  // A known nested id is still read for what it is.
  const elsewhere = `${SUB_ID}/resourceGroups/rg-prod`;
  assert.deepEqual(verdict(checkPlan(plan(replicated({ disk: OWN_DISK.slice(0, 6), diskKnown: { target_resource_group_id: elsewhere } })), id)), [["outside-scope", "azurerm_site_recovery_replicated_vm.vm"]]);
  assert.deepEqual(checkPlan(plan(replicated({ disk: OWN_DISK.slice(0, 6), diskKnown: { target_resource_group_id: `${SUB_ID}/resourceGroups/${c.rgSecondary}` } })), id), []);
});

test("an unknown element of a list of ids (a failover group's databases) is held to the lab's own resources", () => {
  const id = "az305-23-sql-failover";
  const c = ctx(id, "23");
  const server = (key, rg, group) => ({ address: `azurerm_mssql_server.${key}`, values: { name: `${c.prefix}-sql${key}`, resource_group_name: rg, location: "uksouth", version: "12.0" }, refs: { resource_group_name: [`azurerm_resource_group.${group}.name`, `azurerm_resource_group.${group}`] } });
  const db = { address: "azurerm_mssql_database.primary", values: { name: "sqldb-app" }, unknown: ["server_id"], refs: { server_id: ["azurerm_mssql_server.p.id", "azurerm_mssql_server.p"] } };
  const group = (databases) => ({
    address: "azurerm_mssql_failover_group.fog",
    values: { name: `${c.prefix}-fog`, read_write_endpoint_failover_policy: [{ mode: "Manual" }], partner_server: [{}], databases: ["(unknown)"] },
    unknown: ["server_id", "partner_server.0.id", "databases.0"],
    refs: { server_id: ["azurerm_mssql_server.p.id", "azurerm_mssql_server.p"], "partner_server.0.id": ["azurerm_mssql_server.s.id", "azurerm_mssql_server.s"], databases },
  });
  // Something outside the lab, read at plan (a data source deferred to apply would be unknown here too).
  const otherDb = { address: "data.azurerm_resource_group.other", values: { name: "rg-prod" } };
  const plan = (databases) => realisticPlan({ resources: [rgResource(c), rgSecondaryResource(c), server("p", c.rg, "lab"), server("s", c.rgSecondary, "secondary"), db, group(databases)], data: [otherDb] });
  assert.deepEqual(checkPlan(plan(["azurerm_mssql_database.primary.id", "azurerm_mssql_database.primary"]), id), []);
  assert.deepEqual(verdict(checkPlan(plan(["data.azurerm_resource_group.other.id", "data.azurerm_resource_group.other"]), id)), [["outside-scope", "azurerm_mssql_failover_group.fog"]]);
  assert.deepEqual(verdict(checkPlan(plan(["var.database_ids"]), id)), [["outside-scope", "azurerm_mssql_failover_group.fog"]]);
  assert.match(checkPlan(plan(["var.database_ids"]), id)[0].message, /databases\.0 comes from var\.database_ids/);
});

// Identity change 2 (approved by Steven 2026-10-05): lab 20 assigns its two custom roles from Terraform.
test("lab 20 may assign its own custom roles inside its group, and no other lab may", () => {
  const roles = { netops: "60bdbc03-b25a-4a83-9fce-b2c5afff563c", appops: "bd52e05a-22cb-4bd5-b56c-3396add9b7c0" };
  const hcl = {
    data: { azurerm_subscription: { current: [{}] } },
    resource: {
      azurerm_resource_group: RG_HCL,
      azurerm_user_assigned_identity: { ops: [{ name: "id-ops", resource_group_name: "${azurerm_resource_group.lab.name}", location: "${azurerm_resource_group.lab.location}" }] },
      azurerm_role_definition: Object.fromEntries(Object.entries(roles).map(([k, g]) => [k, [{ role_definition_id: g, name: `lab-\${var.lab_id}-${k}`, scope: "${data.azurerm_subscription.current.id}", assignable_scopes: ["${azurerm_resource_group.lab.id}"], permissions: [{ actions: ["Microsoft.Resources/subscriptions/resourceGroups/read"] }] }]])),
      azurerm_role_assignment: Object.fromEntries(Object.keys(roles).map((k) => [k, [{ scope: "${azurerm_resource_group.lab.id}", role_definition_id: `\${azurerm_role_definition.${k}.role_definition_resource_id}`, principal_id: "${azurerm_user_assigned_identity.ops.principal_id}", principal_type: "ServicePrincipal" }]])),
    },
  };
  assert.deepEqual(checkHcl(hcl, "az305-20-landing-zone"), []);
  assert.deepEqual(verdict(checkHcl(hcl, "az305-21-monitoring-scale")).map(([rule]) => rule), ["role", "role", "role", "role"]);
});

// Review (labs batch 3): a whole top-level attribute not known until apply is held to its references like a nested
// one. A failover group's databases from a data source (a splat, of unknown length, has only the data source's own
// address as its reference) or a variable must not pass because the attribute is not a scope attribute.
test("an unknown top-level attribute built from ids is held to the lab's own resources", () => {
  const id = "az305-23-sql-failover";
  const c = ctx(id, "23");
  const server = (key, rg, group) => ({ address: `azurerm_mssql_server.${key}`, values: { name: `${c.prefix}-sql${key}`, resource_group_name: rg, location: "uksouth", version: "12.0" }, refs: { resource_group_name: [`azurerm_resource_group.${group}.name`, `azurerm_resource_group.${group}`] } });
  const db = { address: "azurerm_mssql_database.primary", values: { name: "sqldb-app" }, unknown: ["server_id"], refs: { server_id: ["azurerm_mssql_server.p.id", "azurerm_mssql_server.p"] } };
  const group = (databases) => ({
    address: "azurerm_mssql_failover_group.fog",
    values: { name: `${c.prefix}-fog`, read_write_endpoint_failover_policy: [{ mode: "Manual" }], partner_server: [{}] },
    unknown: ["server_id", "partner_server.0.id", "databases"],
    refs: { server_id: ["azurerm_mssql_server.p.id", "azurerm_mssql_server.p"], "partner_server.0.id": ["azurerm_mssql_server.s.id", "azurerm_mssql_server.s"], databases },
  });
  const plan = (databases) => realisticPlan({ resources: [rgResource(c), rgSecondaryResource(c), server("p", c.rg, "lab"), server("s", c.rgSecondary, "secondary"), db, group(databases)] }); // the data source is deferred to apply: in the configuration only
  // The lab's own databases (a splat over them lists the resource itself): passes.
  assert.deepEqual(checkPlan(plan(["azurerm_mssql_database.primary.id", "azurerm_mssql_database.primary"]), id), []);
  assert.deepEqual(checkPlan(plan(["azurerm_mssql_database.primary"]), id), []);
  // data.x[*].id: Terraform lists the data source alone. Refused, as is a variable of ids.
  assert.deepEqual(verdict(checkPlan(plan(["data.azurerm_mssql_database.other"]), id)), [["outside-scope", "azurerm_mssql_failover_group.fog"]]);
  assert.match(checkPlan(plan(["data.azurerm_mssql_database.other"]), id)[0].message, /^databases comes from data\.azurerm_mssql_database\.other/);
  assert.deepEqual(verdict(checkPlan(plan(["var.database_ids"]), id)), [["outside-scope", "azurerm_mssql_failover_group.fog"]]);
  assert.deepEqual(verdict(checkPlan(plan(["data.azurerm_mssql_database.other.id", "data.azurerm_mssql_database.other"]), id)), [["outside-scope", "azurerm_mssql_failover_group.fog"]]);
  // In HCL: the splat, and a dynamic partner_server over a data source, are refused too. (A plan never shows a
  // dynamic block's expressions, terraform jsonconfig skips them, so the HCL check is where a dynamic block is read.)
  const hcl = (fog) => ({
    data: { azurerm_mssql_server: { other: [{ name: "sql-prod", resource_group_name: "rg-prod" }] }, azurerm_mssql_database: { other: [{ name: "sqldb-prod", server_id: "${data.azurerm_mssql_server.other.id}" }] } },
    resource: {
      azurerm_resource_group: { lab: RG_HCL.lab, secondary: [{ name: "${var.resource_group_name}-secondary", location: "${var.secondary_region}" }] },
      azurerm_mssql_server: {
        p: [{ name: "${var.name_prefix}-sqlp", resource_group_name: "${azurerm_resource_group.lab.name}", location: "${azurerm_resource_group.lab.location}", version: "12.0" }],
        s: [{ name: "${var.name_prefix}-sqls", resource_group_name: "${azurerm_resource_group.secondary.name}", location: "${azurerm_resource_group.secondary.location}", version: "12.0" }],
      },
      azurerm_mssql_failover_group: { fog: [{ name: "${var.name_prefix}-fog", server_id: "${azurerm_mssql_server.p.id}", read_write_endpoint_failover_policy: [{ mode: "Manual" }], ...fog }] },
    },
  });
  assert.deepEqual(checkHcl(hcl({ partner_server: [{ id: "${azurerm_mssql_server.s.id}" }] }), id), []);
  assert.deepEqual(verdict(checkHcl(hcl({ partner_server: [{ id: "${azurerm_mssql_server.s.id}" }], databases: "${data.azurerm_mssql_database.other[*].id}" }), id)), [["outside-scope", "azurerm_mssql_failover_group.fog"]]);
  assert.deepEqual(verdict(checkHcl(hcl({ dynamic: { partner_server: [{ for_each: "${data.azurerm_mssql_server.other[*]}", content: [{ id: "${partner_server.value.id}" }] }] } }), id)), [["outside-scope", "azurerm_mssql_failover_group.fog"]]);
});

// Review (labs batch 3): an id inside a JSON string (a policy assignment's parameters, a jsonencode()) is an id.
test("ids inside JSON strings are read for what they are", () => {
  const id = "az305-20-landing-zone";
  const c = ctx(id, "20");
  const foreign = `${SUB_ID}/resourceGroups/rg-other/providers/Microsoft.OperationalInsights/workspaces/law-prod`;
  const own = `${SUB_ID}/resourceGroups/${c.rg}/providers/Microsoft.OperationalInsights/workspaces/law-lab`;
  const BUILTIN = "/providers/Microsoft.Authorization/policyDefinitions/e56962a6-4747-49cd-b67b-bf8b01975c4c";
  const hcl = (parameters) => ({
    resource: {
      azurerm_resource_group: RG_HCL,
      azurerm_management_group: { corp: [{ name: "lab-${var.lab_id}-corp", display_name: "lab-${var.lab_id}-corp" }] },
      azurerm_management_group_policy_assignment: { diag: [{ name: "diag", management_group_id: "${azurerm_management_group.corp.id}", policy_definition_id: BUILTIN, parameters }] },
    },
  });
  const params = (v) => JSON.stringify({ logAnalytics: { value: v } });
  assert.deepEqual(checkHcl(hcl(params("eastus")), id), []);
  assert.deepEqual(checkHcl(hcl(params(own)), id), []);
  assert.deepEqual(verdict(checkHcl(hcl(params(foreign)), id)), [["outside-scope", "azurerm_management_group_policy_assignment.diag"]]);
  assert.match(checkHcl(hcl(params(foreign)), id)[0].message, /parameters.*logAnalytics\.value.*rg-other/);
  // A list, a management group not the lab's, the subscription, and keys hold ids too.
  assert.deepEqual(verdict(checkHcl(hcl(JSON.stringify([{ scopes: [own, foreign] }])), id)), [["outside-scope", "azurerm_management_group_policy_assignment.diag"]]);
  assert.deepEqual(verdict(checkHcl(hcl(params("/providers/Microsoft.Management/managementGroups/corp")), id)), [["outside-scope", "azurerm_management_group_policy_assignment.diag"]]);
  assert.deepEqual(verdict(checkHcl(hcl(params(SUB_ID)), id)), [["outside-scope", "azurerm_management_group_policy_assignment.diag"]]);
  assert.deepEqual(verdict(checkHcl(hcl(JSON.stringify({ [foreign]: { value: 1 } })), id)), [["outside-scope", "azurerm_management_group_policy_assignment.diag"]]);
  // Not JSON after all: left as a string.
  assert.deepEqual(checkHcl(hcl("{not json"), id), []);
  // In a plan: a known JSON string with a foreign id is refused; a jsonencode() of an unknown id is held to its references.
  const assignment = (parameters, refs = {}, unknown = []) => ({ address: "azurerm_management_group_policy_assignment.diag", values: { name: "diag", policy_definition_id: BUILTIN, ...(parameters === undefined ? {} : { parameters }) }, unknown: ["management_group_id", ...unknown], refs: { management_group_id: ["azurerm_management_group.corp.id", "azurerm_management_group.corp"], ...refs } });
  const mg = { address: "azurerm_management_group.corp", values: { name: `lab-${id}-corp`, display_name: `lab-${id}-corp` } };
  const law = { address: "azurerm_log_analytics_workspace.law", values: { name: "law-lab", resource_group_name: c.rg, location: "uksouth" }, refs: { resource_group_name: ["azurerm_resource_group.lab.name", "azurerm_resource_group.lab"] } };
  const plan = (a) => realisticPlan({ resources: [rgResource(c), mg, law, a] });
  assert.deepEqual(checkPlan(plan(assignment(params(own))), id), []);
  assert.deepEqual(verdict(checkPlan(plan(assignment(params(foreign))), id)), [["outside-scope", "azurerm_management_group_policy_assignment.diag"]]);
  assert.deepEqual(checkPlan(plan(assignment(undefined, { parameters: ["azurerm_log_analytics_workspace.law.id", "azurerm_log_analytics_workspace.law"] }, ["parameters"])), id), []);
  assert.deepEqual(verdict(checkPlan(plan(assignment(undefined, { parameters: ["data.azurerm_log_analytics_workspace.prod.id", "data.azurerm_log_analytics_workspace.prod"] }, ["parameters"])), id)), [["outside-scope", "azurerm_management_group_policy_assignment.diag"]]);
});

// Review (labs batch 3): a deployIfNotExists rule carries a template the remediation deploys; it is checked like
// any template a lab deploys (templateProblems), and its deployment may not be sent to another group or subscription.
test("a DINE rule's embedded template is checked as a template, and its deployment stays in the resource's group", () => {
  const id = "az305-21-monitoring-scale";
  const DIAG = { type: "Microsoft.KeyVault/vaults/providers/diagnosticSettings", apiVersion: "2021-05-01-preview", name: "[concat(parameters('vaultName'), '/Microsoft.Insights/setbypolicy-alllogs')]", properties: { workspaceId: "[parameters('logAnalytics')]", logs: [{ categoryGroup: "allLogs", enabled: true }] } };
  const withTemplate = (resources, deployment = {}, extra = {}) => {
    const rule = dineRule([MONITORING_CONTRIBUTOR]);
    rule.then.details.deployment = { ...deployment, properties: { mode: "incremental", template: { $schema: RG_SCHEMA, contentVersion: "1.0.0.0", parameters: { vaultName: { type: "string" }, logAnalytics: { type: "string" } }, resources, ...extra }, parameters: { vaultName: { value: "[field('name')]" } } } };
    return dineHcl(rule);
  };
  // Lab 21's own: a Key Vault's diagnostic setting.
  assert.deepEqual(checkHcl(withTemplate([DIAG]), id), []);
  const refused = (hcl) => verdict(checkHcl(hcl, id)).map(([rule]) => rule);
  // A role assignment, a deployment script, a type off the list, a foreign id, subscription() in the template: refused.
  assert.deepEqual(refused(withTemplate([{ type: "Microsoft.Authorization/roleAssignments", apiVersion: "2022-04-01", name: "[guid('x')]", properties: { roleDefinitionId: `/providers/Microsoft.Authorization/roleDefinitions/${OWNER}`, principalId: "x" } }])), ["role"]);
  assert.deepEqual(refused(withTemplate([{ type: "Microsoft.Resources/deploymentScripts", apiVersion: "2023-08-01", name: "s", kind: "AzureCLI", properties: {} }])), ["outside-scope"]);
  assert.deepEqual(refused(withTemplate([{ type: "Microsoft.Compute/virtualMachines", apiVersion: "2024-03-01", name: "vm", properties: {} }])), ["outside-scope"]);
  assert.deepEqual(refused(withTemplate([{ ...DIAG, properties: { ...DIAG.properties, workspaceId: `${SUB_ID}/resourceGroups/rg-other/providers/Microsoft.OperationalInsights/workspaces/law` } }])), ["outside-scope"]);
  assert.deepEqual(refused(withTemplate([{ ...DIAG, properties: { ...DIAG.properties, workspaceId: "[concat(subscription().id, '/x')]" } }])), ["outside-scope"]);
  assert.deepEqual(refused(withTemplate([DIAG], {}, { $schema: "https://schema.management.azure.com/schemas/2018-05-01/subscriptionDeploymentTemplate.json#" })), ["outside-scope"]);
  assert.match(checkHcl(withTemplate([{ type: "Microsoft.Compute/virtualMachines", apiVersion: "2024-03-01", name: "vm", properties: {} }]), id)[0].message, /policy_rule's deployment template/);
  // The deployment sent to another group or subscription (any case of the key), or a linked template.
  assert.deepEqual(refused(withTemplate([DIAG], { resourceGroup: "rg-other" })), ["outside-scope"]);
  assert.deepEqual(refused(withTemplate([DIAG], { SubscriptionId: "00000000-0000-0000-0000-000000000000" })), ["outside-scope"]);
  const linked = dineRule([MONITORING_CONTRIBUTOR]);
  linked.then.details.deployment = { properties: { mode: "incremental", templateLink: { uri: "https://example.com/t.json" } } };
  assert.deepEqual(refused(dineHcl(linked)), ["outside-scope"]);
  // The lab's own group, by name or as the resource's group, is fine.
  assert.deepEqual(checkHcl(withTemplate([DIAG], { resourceGroup: "[resourceGroup().name]" }), id), []);
  assert.deepEqual(checkHcl(withTemplate([DIAG], { resourceGroup: `rg-lab-${id}` }), id), []);
  // Lab 21's real plan still passes.
  assert.deepEqual(checkPlan(LAB_PLANS[id].plan, id), []);
});

// ── What batch 3's real plans showed (release tests, 2026-10-06) ─────────

// Labs 22 and 26 recorded their VMs' admin_ssh_key with no references at all: `terraform show -json` leaves a
// dynamic block out of configuration.expressions, while its values are in the plan. So an unknown value inside a
// dynamic block carried no references and looked computed by the provider, and an id from a data source deferred
// to apply (a subnet in another group) passed. A plan now refuses an unknown value inside a dynamic block: the
// check cannot see where it comes from. (The HCL check reads dynamic blocks; a VM's admin_ssh_key, all known, passes.)
test("an unknown value inside a dynamic block is refused in a plan, which leaves dynamic blocks out of its configuration", () => {
  const id = "az104-07-files";
  const c = ctx(id, "07");
  const vnet = { address: "azurerm_virtual_network.lab", values: { name: "vnet-lab", resource_group_name: c.rg, location: "uksouth", address_space: ["10.64.64.0/20"], tags: c.tags }, refs: IN_RG };
  const subnet = { address: "azurerm_subnet.vms", values: { name: "snet-vms", resource_group_name: c.rg, virtual_network_name: "vnet-lab", address_prefixes: ["10.64.64.0/24"] }, refs: { resource_group_name: IN_RG.resource_group_name, virtual_network_name: ref("azurerm_virtual_network.lab", "name") } };
  const nic = (dynamic, subnetRefs) => ({
    address: "azurerm_network_interface.x",
    values: { name: "nic-x", resource_group_name: c.rg, location: "uksouth", tags: c.tags, ip_configuration: [{ name: "ipconfig1", subnet_id: "(unknown)", private_ip_address_allocation: "Dynamic" }] },
    unknown: ["ip_configuration.0.subnet_id"],
    refs: dynamic ? { ...IN_RG } : { ...IN_RG, "ip_configuration.0.subnet_id": subnetRefs },
    ...(dynamic ? { dynamic: ["ip_configuration"] } : {}),
  });
  const plan = (r) => {
    const p = realisticPlan({ resources: [rgResource(c), vnet, subnet, r], variables: c.variables });
    // A data source in another group, deferred to apply (it depends on a lab resource): in the configuration only.
    p.configuration.root_module.resources.push({
      address: "data.azurerm_subnet.prod",
      mode: "data",
      type: "azurerm_subnet",
      name: "prod",
      provider_config_key: "azurerm",
      expressions: { name: { constant_value: "snet-app" }, virtual_network_name: { constant_value: "vnet-prod" }, resource_group_name: { constant_value: "rg-prod" } },
      depends_on: ["azurerm_resource_group.lab"],
    });
    return p;
  };
  // Written out, the block is held to its references: the lab's own subnet passes, the deferred data source does not.
  assert.deepEqual(checkPlan(plan(nic(false, ref("azurerm_subnet.vms", "id"))), id), []);
  assert.deepEqual(verdict(checkPlan(plan(nic(false, ref("data.azurerm_subnet.prod", "id"))), id)), [["outside-scope", "azurerm_network_interface.x"]]);
  // As a dynamic block the plan shows the unknown id and nothing of where it comes from: refused. So is any
  // unknown value in it, the provider's own too (which this check cannot tell from a configured one).
  const p = plan(nic(true));
  assert.equal(p.configuration.root_module.resources.find((r) => r.address === "azurerm_network_interface.x").expressions.ip_configuration, undefined, "the plan's configuration leaves the dynamic block out");
  const refused = checkPlan(p, id);
  assert.deepEqual(verdict(refused), [["outside-scope", "azurerm_network_interface.x"]]);
  assert.match(refused[0].message, /^ip_configuration\.0\.[a-z_]+ is unknown inside a dynamic block/);
  assert.ok(planResources(p).resources.find((r) => r.address === "azurerm_network_interface.x").values.ip_configuration[0].subnet_id.dynamic, "the subnet id is marked as inside a dynamic block");
  // A VM's dynamic admin_ssh_key holds only known values: it passes, as the real labs 22 and 26 did.
  const [vmNic, vm] = linuxVm(c, { name: "vm-files", subnet: "azurerm_subnet.vms" });
  const withVm = realisticPlan({ resources: [rgResource(c), vnet, subnet, vmNic, vm], variables: c.variables });
  assert.equal(withVm.configuration.root_module.resources.find((r) => r.address === vm.address).expressions.admin_ssh_key, undefined);
  assert.ok(withVm.planned_values.root_module.resources.find((r) => r.address === vm.address).values.admin_ssh_key.length);
  assert.deepEqual(checkPlan(withVm, id), []);
});

// Lab 23's real plan left two lists of ids wholly unknown (after_unknown "databases": true and
// "private_dns_zone_group.0.private_dns_zone_ids": true, not their ".0" elements, which the fixture had). A wholly
// unknown list is held to the whole expression's references, so a zone or a database from outside the lab is
// refused. A literal id mixed into such a list never reaches the plan (Terraform prints only references for an
// expression that is not constant): the HCL check, in CI, is where it is caught.
test("a list of ids a plan leaves wholly unknown is held to its references, and a literal in it is caught in HCL", () => {
  const id = "az305-23-sql-failover";
  const c = ctx(id, "23");
  const zone = { address: "azurerm_private_dns_zone.sql", values: { name: "privatelink.database.windows.net", resource_group_name: c.rg, tags: c.tags }, refs: { resource_group_name: IN_RG.resource_group_name, tags: ["var.tags"] } };
  const endpoint = (zoneRefs) => ({
    address: "azurerm_private_endpoint.primary",
    values: {
      name: "pe-sqlp",
      resource_group_name: c.rg,
      location: "uksouth",
      tags: c.tags,
      private_service_connection: [{ name: "psc-sqlp", subresource_names: ["sqlServer"], is_manual_connection: false }],
      private_dns_zone_group: [{ name: "sql" }],
    },
    unknown: ["subnet_id", "private_service_connection.0.private_connection_resource_id", "private_dns_zone_group.0.private_dns_zone_ids"],
    refs: {
      ...IN_RG,
      subnet_id: ref("azurerm_resource_group.lab", "id"),
      "private_service_connection.0.private_connection_resource_id": ref("azurerm_resource_group.lab", "id"),
      "private_dns_zone_group.0.private_dns_zone_ids": zoneRefs,
    },
  });
  const plan = (zoneRefs) => realisticPlan({ resources: [rgResource(c), zone, endpoint(zoneRefs)], variables: c.variables });
  const own = ref("azurerm_private_dns_zone.sql", "id");
  assert.equal(plan(own).resource_changes.at(-1).change.after_unknown.private_dns_zone_group[0].private_dns_zone_ids, true, "wholly unknown, as the real plan printed it");
  assert.deepEqual(checkPlan(plan(own), id), []);
  // The gateway's own privatelink zone, or any zone found by a data source or passed in: refused.
  assert.deepEqual(verdict(checkPlan(plan(ref("data.azurerm_private_dns_zone.shared", "id")), id)), [["outside-scope", "azurerm_private_endpoint.primary"]]);
  assert.deepEqual(verdict(checkPlan(plan([...own, "var.zone_ids"]), id)), [["outside-scope", "azurerm_private_endpoint.primary"]]);
  // In HCL, a literal id in the list is read for what it is.
  const foreign = `${SUB_ID}/resourceGroups/rg-prod/providers/Microsoft.Network/privateDnsZones/privatelink.database.windows.net`;
  const hcl = (ids) => ({
    resource: {
      azurerm_resource_group: RG_HCL,
      azurerm_private_dns_zone: { sql: [{ name: "privatelink.database.windows.net", resource_group_name: "${azurerm_resource_group.lab.name}" }] },
      azurerm_private_endpoint: {
        primary: [
          {
            name: "pe-sqlp",
            resource_group_name: "${azurerm_resource_group.lab.name}",
            location: "${azurerm_resource_group.lab.location}",
            subnet_id: "${azurerm_resource_group.lab.id}",
            private_service_connection: [{ name: "psc-sqlp", private_connection_resource_id: "${azurerm_resource_group.lab.id}", subresource_names: ["sqlServer"], is_manual_connection: false }],
            private_dns_zone_group: [{ name: "sql", private_dns_zone_ids: ids }],
          },
        ],
      },
    },
  });
  assert.deepEqual(checkHcl(hcl(["${azurerm_private_dns_zone.sql.id}"]), id), []);
  assert.deepEqual(verdict(checkHcl(hcl(["${azurerm_private_dns_zone.sql.id}", foreign]), id)), [["outside-scope", "azurerm_private_endpoint.primary"]]);
});
