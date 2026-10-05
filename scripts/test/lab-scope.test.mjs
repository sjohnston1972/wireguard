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
