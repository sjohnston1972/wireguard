// labs-az305-identity.test.mjs
//
// Plain English: the AZ-305 governance and identity labs (labs batch 3 plan,
// area C1: labs 20, 21 and 22) checked without touching Azure. Each runs the
// shared content suite (fixtures/labs/content.mjs: catalogue rules, lint, one
// resource group, sizes, disks, prices, marker, fmt, and with identity
// "match" lab.yaml's role list against the Terraform's role assignments),
// then its own tests: what it builds, that nothing it assigns reaches beyond
// its own group or management groups, and that tear-down can get it back to
// £0 (no purge protection, a vault purged on destroy, a workspace deleted for
// good). init, validate and the mock plan are npm run labs-tf's job.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_ROLES } from "../lib/labs.mjs";
import { attr, lab, labContentSuite, resources, roleAssignments, uncomment } from "./fixtures/labs/content.mjs";

const LZ = "az305-20-landing-zone";

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

/** Every nested block `name { ... }` directly or deeper in `body`. */
function allNested(body, name) {
  const out = [];
  let rest = body ?? "";
  for (let b = nested(rest, name); b !== undefined; b = nested(rest, name)) {
    out.push(b);
    rest = rest.slice(rest.indexOf(b) + b.length);
  }
  return out;
}

/** A list literal's quoted strings: ["a", "b"] -> ["a", "b"]. */
const strings = (v) => [...(v ?? "").matchAll(/"([^"]*)"/g)].map((m) => m[1]);

/** The text between `name = [` and its closing `]` (a multi-line list), or undefined. */
function list(body, name) {
  const m = new RegExp(`(?:^|\\n)[ \\t]*${name}[ \\t]*=[ \\t]*\\[`).exec(body ?? "");
  if (!m) return undefined;
  let depth = 0;
  let i = m.index + m[0].length - 1;
  for (; i < body.length; i++) {
    if (body[i] === "[") depth++;
    else if (body[i] === "]" && --depth === 0) break;
  }
  return body.slice(m.index + m[0].length, i);
}

/** The azurerm provider's features block from versions.tf. */
const features = (l) => {
  const p = l.blocks.find((b) => b.kind === "provider" && b.labels[0] === "azurerm");
  assert.ok(p, 'versions.tf has provider "azurerm"');
  const f = nested(p.body, "features");
  assert.ok(f !== undefined, "the azurerm provider has a features block");
  return f;
};

const one = (l, type) => {
  const rs = resources(l, type);
  assert.equal(rs.length, 1, `exactly one ${type}`);
  return rs[0];
};

/** The resource of `type` whose `name` attribute is exactly `name` (as written in HCL, quotes included). */
const named = (l, type, name) => {
  const r = resources(l, type).find((x) => attr(x.body, "name") === name);
  assert.ok(r, `a ${type} named ${name}`);
  return r;
};

/** A built-in policy definition's id. */
const builtInPolicy = (guid) => `/providers/Microsoft.Authorization/policyDefinitions/${guid}`;
/** A policy_definition_id: a literal, or a local holding one (lab 2's pattern). */
function policyIdOf(l, body) {
  const v = attr(body, "policy_definition_id") ?? "";
  const local = /^local\.([A-Za-z0-9_]+)$/.exec(v);
  if (!local) return v.replace(/^"|"$/g, "");
  const locals = l.blocks.filter((b) => b.kind === "locals").map((b) => b.body).join("\n");
  return (attr(locals, local[1]) ?? "").replace(/^"|"$/g, "");
}

// ── Lab 20: landing zone lite ────────────────────────────────────────────

labContentSuite(LZ, { marker: "£", identity: "match" });

const MGS = { root: null, platform: "root", landingzones: "root", corp: "landingzones", online: "landingzones", sandbox: "root" };

test(`${LZ}: six lab management groups three deep under the tenant root, none holding a subscription`, () => {
  const l = lab(LZ);
  const mgs = resources(l, "azurerm_management_group");
  assert.deepEqual(mgs.map((m) => m.labels[1]).sort(), Object.keys(MGS).sort(), "the six management groups");
  for (const m of mgs) {
    const key = m.labels[1];
    assert.equal(attr(m.body, "name"), `"lab-\${var.lab_id}-${key}"`, `${key}: named lab-<id>-${key}`);
    assert.equal(attr(m.body, "display_name"), `"lab-\${var.lab_id}-${key}"`, `${key}: displayed as lab-<id>-${key}`);
    const parent = attr(m.body, "parent_management_group_id");
    if (MGS[key] === null) assert.equal(parent, undefined, "lab-<id>-root hangs under the tenant root group");
    else assert.equal(parent, `azurerm_management_group.${MGS[key]}.id`, `${key} sits under ${MGS[key]}`);
    // The subscription is never moved in: a deny at a parent would reach the gateway.
    assert.equal(attr(m.body, "subscription_ids"), undefined, `${key}: no subscription_ids`);
  }
  // Three deep: root > landingzones > corp and online.
  const depth = (k) => (MGS[k] === null ? 1 : 1 + depth(MGS[k]));
  assert.equal(Math.max(...Object.keys(MGS).map(depth)), 3);
  assert.deepEqual(resources(l).filter((r) => /subscription_association|^azurerm_subscription$/.test(r.labels[0])).map((r) => r.labels.join(".")), [], "no subscription is associated or made");
});

test(`${LZ}: an initiative at lab-<id>-root with grouped built-in and custom definitions`, () => {
  const l = lab(LZ);
  // The custom definition: audit only, stored at lab-<id>-root.
  const audit = one(l, "azurerm_policy_definition");
  assert.equal(attr(audit.body, "name"), '"lab-${var.lab_id}-audit-costcentre"');
  assert.equal(attr(audit.body, "management_group_id"), "azurerm_management_group.root.id", "stored at lab-<id>-root, not the subscription");
  assert.equal(attr(audit.body, "policy_type"), '"Custom"');
  assert.match(audit.body, /effect\s*=\s*"audit"/i, "the custom definition only audits");
  assert.doesNotMatch(audit.body, /deny|deployIfNotExists|modify/i, "and never denies or remediates");

  const set = one(l, "azurerm_management_group_policy_set_definition");
  assert.equal(attr(set.body, "name"), '"lab-${var.lab_id}-baseline"');
  assert.equal(attr(set.body, "display_name")?.startsWith('"lab-${var.lab_id}'), true, "displayed with the lab's prefix");
  assert.equal(attr(set.body, "management_group_id"), "azurerm_management_group.root.id", "stored at lab-<id>-root");
  assert.equal(attr(set.body, "policy_type"), '"Custom"');
  const groups = allNested(set.body, "policy_definition_group").map((g) => attr(g, "name")?.replace(/"/g, ""));
  assert.ok(groups.length >= 2, `policy definition groups (${groups.join(", ")})`);
  const refs = allNested(set.body, "policy_definition_reference");
  assert.equal(refs.length, 3, "three definitions in the initiative");
  const ids = refs.map((r) => attr(r, "policy_definition_id"));
  assert.deepEqual(
    ids.map((x) => x.replace(/"/g, "")).sort(),
    [builtInPolicy("96670d01-0a4d-4649-9c89-2d3abc0a5025"), builtInPolicy("e56962a6-4747-49cd-b67b-bf8b01975c4c"), `azurerm_policy_definition.${audit.labels[1]}.id`].sort(),
    "built-in Allowed locations and Require a tag on resource groups, and the custom audit",
  );
  for (const r of refs) {
    const names = strings(attr(r, "policy_group_names"));
    assert.ok(names.length >= 1 && names.every((n) => groups.includes(n)), `${attr(r, "policy_definition_id")}: in a declared group (${names.join(", ")})`);
  }
  const byId = (guid) => refs.find((r) => attr(r, "policy_definition_id").includes(guid));
  assert.match(byId("e56962a6-4747-49cd-b67b-bf8b01975c4c"), /listOfAllowedLocations\s*=\s*\{\s*value\s*=\s*\[var\.region\]/, "Allowed locations: the session's region");
  assert.match(byId("96670d01-0a4d-4649-9c89-2d3abc0a5025"), /tagName\s*=\s*\{\s*value\s*=\s*"costcentre"/, "Require a tag on resource groups: costcentre");
});

test(`${LZ}: the initiative is assigned at landingzones and a deny of public IPs at sandbox, names at most 24 characters`, () => {
  const l = lab(LZ);
  const set = one(l, "azurerm_management_group_policy_set_definition");
  const as = resources(l, "azurerm_management_group_policy_assignment");
  assert.equal(as.length, 2, "two management group assignments");
  for (const a of as) {
    const name = attr(a.body, "name");
    assert.match(name, /^"[a-z0-9-]+"$/, `${a.labels[1]}: a literal name`);
    assert.ok(name.replace(/"/g, "").length <= 24, `${name}: at most 24 characters at management group scope`);
    assert.ok(attr(a.body, "display_name")?.startsWith('"lab-${var.lab_id}-'), `${a.labels[1]}: the display name carries lab-<id>-`);
    // Neither has an identity: nothing remediates, so no role is given to anything.
    assert.equal(nested(a.body, "identity"), undefined, `${a.labels[1]}: no managed identity`);
  }
  const lz = as.find((a) => attr(a.body, "name") === '"lz-baseline"');
  assert.ok(lz, "lz-baseline");
  assert.equal(attr(lz.body, "policy_definition_id"), `azurerm_management_group_policy_set_definition.${set.labels[1]}.id`);
  assert.equal(attr(lz.body, "management_group_id"), "azurerm_management_group.landingzones.id", "the initiative applies at landingzones (corp and online inherit it)");
  const sb = as.find((a) => attr(a.body, "name") === '"sandbox-no-pip"');
  assert.ok(sb, "sandbox-no-pip");
  assert.equal(policyIdOf(l, sb.body), builtInPolicy("6c112d4e-5bc7-47ae-a041-ea2d9dccd749"), "built-in Not allowed resource types");
  assert.equal(attr(sb.body, "management_group_id"), "azurerm_management_group.sandbox.id");
  assert.match(sb.body, /listOfResourceTypesNotAllowed\s*=\s*\{\s*value\s*=\s*\["Microsoft\.Network\/publicIPAddresses"\]/);
  // Nothing at subscription scope.
  assert.deepEqual(resources(l).filter((r) => /^azurerm_subscription_/.test(r.labels[0])).map((r) => r.labels.join(".")), []);
});

test(`${LZ}: two custom roles with their fixed GUIDs, assignable only at rg-lab-<id>, each assigned there to its own managed identity`, () => {
  const l = lab(LZ);
  const defs = resources(l, "azurerm_role_definition");
  const custom = ALLOWED_ROLES.custom.filter((c) => c.lab === LZ);
  assert.equal(custom.length, 2, "allowed-roles.json lists lab 20's two roles");
  assert.equal(defs.length, 2, "two custom roles");
  const subscription = l.blocks.find((b) => b.kind === "data" && b.labels[0] === "azurerm_subscription");
  assert.ok(subscription, "data.azurerm_subscription: the roles are defined at the subscription");
  const uais = resources(l, "azurerm_user_assigned_identity");
  assert.equal(uais.length, 2, "two user-assigned identities, one per role");
  const ras = resources(l, "azurerm_role_assignment");
  assert.equal(ras.length, 2, "two role assignments");
  const principals = new Set();
  for (const c of custom) {
    const persona = c.name.slice(`lab-${LZ}-`.length);
    const def = defs.find((d) => attr(d.body, "role_definition_id") === `"${c.id}"`);
    assert.ok(def, `${c.name}: role_definition_id ${c.id}`);
    assert.equal(attr(def.body, "name"), `"lab-\${var.lab_id}-${persona}"`);
    assert.equal(attr(def.body, "scope"), `data.azurerm_subscription.${subscription.labels[1]}.id`);
    assert.equal(attr(def.body, "assignable_scopes"), "[azurerm_resource_group.lab.id]", `${c.name}: assignable only at rg-lab-<id>`);
    // Least privilege: no wildcard but a read, nothing that writes access.
    const actions = strings(list(nested(def.body, "permissions"), "actions"));
    assert.ok(actions.length >= 3, `${c.name}: its actions (${actions.join(", ")})`);
    for (const a of actions) {
      assert.ok(!a.includes("*") || /\/read$/.test(a), `${c.name}: ${a} is a wildcard that is not a read`);
      assert.doesNotMatch(a, /^Microsoft\.Authorization\//, `${c.name}: ${a} would touch access`);
    }
    assert.ok(actions.includes("Microsoft.Resources/subscriptions/resourceGroups/read"), `${c.name}: can see its resource group`);
    // Its persona: a managed identity in rg-lab-<id>.
    const uai = uais.find((u) => attr(u.body, "name") === `"id-\${var.name_prefix}-${persona}"`);
    assert.ok(uai, `id-<prefix>-${persona}`);
    assert.equal(attr(uai.body, "resource_group_name"), "azurerm_resource_group.lab.name");
    const ra = ras.find((r) => attr(r.body, "role_definition_id") === `azurerm_role_definition.${def.labels[1]}.role_definition_resource_id`);
    assert.ok(ra, `${c.name} is assigned`);
    assert.equal(attr(ra.body, "scope"), "azurerm_resource_group.lab.id", `${c.name}: assigned at rg-lab-<id>, the only scope it is assignable at`);
    assert.equal(attr(ra.body, "principal_id"), `azurerm_user_assigned_identity.${uai.labels[1]}.principal_id`, `${c.name}: to id-<prefix>-${persona}`);
    assert.equal(attr(ra.body, "principal_type"), '"ServicePrincipal"');
    principals.add(attr(ra.body, "principal_id"));
  }
  assert.equal(principals.size, 2, "each role to its own identity");
  const netops = defs.find((d) => attr(d.body, "role_definition_id") === '"60bdbc03-b25a-4a83-9fce-b2c5afff563c"');
  const appops = defs.find((d) => attr(d.body, "role_definition_id") === '"bd52e05a-22cb-4bd5-b56c-3396add9b7c0"');
  assert.match(netops.body, /Microsoft\.Network\/networkSecurityGroups\/securityRules\/write/);
  assert.match(netops.body, /Microsoft\.Network\/routeTables\/routes\/write/);
  assert.match(appops.body, /Microsoft\.Compute\/virtualMachines\/restart\/action/);
  assert.match(appops.body, /Microsoft\.Insights\/metrics\/read/);
  // The suite's view agrees: both at the resource group, by name.
  assert.deepEqual(roleAssignments(l).map((r) => `${r.role}@${r.scope}`).sort(), custom.map((c) => `${c.name}@resource_group`).sort());
});

test(`${LZ}: the readme says nothing is evaluated and never to move the subscription into the tree`, () => {
  const r = lab(LZ).readme;
  assert.match(r, /[Nn]o subscription/);
  assert.match(r, /[Nn]ever move/);
  assert.match(r, /gateway/);
  assert.match(r, /exemption/i, "an exemption is a thing to try");
});

test(`${LZ}: no Entra objects and no data source but the subscription`, () => {
  const l = lab(LZ);
  assert.deepEqual(l.blocks.filter((b) => (b.kind === "resource" || b.kind === "data") && b.labels[0].startsWith("azuread_")).map((b) => b.labels.join(".")), []);
  assert.deepEqual(l.blocks.filter((b) => b.kind === "data").map((b) => b.labels[0]), ["azurerm_subscription"]);
  assert.doesNotMatch(uncomment(Object.values(l.files).join("\n")), /"\/subscriptions\//, "no literal subscription ids");
});

// ── Lab 21: monitoring at scale ──────────────────────────────────────────

const MON = "az305-21-monitoring-scale";
const MONITORING_CONTRIBUTOR = "749f88d5-cbae-40b8-bcfc-e573ddc772fa";

labContentSuite(MON, { marker: "£", identity: "match" });

/** The DINE definition: the one azurerm_policy_definition named lab-<id>-kv-diagnostics. */
const dine = (l) => named(l, "azurerm_policy_definition", '"lab-${var.lab_id}-kv-diagnostics"');

test(`${MON}: a PerGB2018 workspace capped at 0.05 GB a day, deleted permanently on destroy`, () => {
  const l = lab(MON);
  const ws = one(l, "azurerm_log_analytics_workspace").body;
  assert.equal(attr(ws, "sku"), '"PerGB2018"');
  assert.equal(attr(ws, "daily_quota_gb"), "0.05", "ingestion can never run away");
  assert.equal(attr(ws, "retention_in_days"), "30", "30 days: the free retention, and the least PerGB2018 takes");
  const law = nested(features(l), "log_analytics_workspace");
  assert.ok(law !== undefined, "features has a log_analytics_workspace block");
  assert.equal(attr(law, "permanently_delete_on_destroy"), "true", "a soft-deleted workspace would be recovered by the next deploy");
  const item = l.yaml.cost.items.find((i) => /Log Analytics/i.test(i.name));
  assert.ok(item, "a Log Analytics cost item");
  assert.equal(item.retail, undefined, "Log Analytics stays authored (batch 2 ruling 2)");
});

test(`${MON}: a DINE definition whose only role is Monitoring Contributor`, () => {
  const l = lab(MON);
  const d = dine(l).body;
  assert.equal(attr(d, "policy_type"), '"Custom"');
  assert.equal(attr(d, "mode"), '"Indexed"');
  assert.equal(attr(d, "management_group_id"), undefined, "defined at the subscription, as lab 2's (assigned only at rg-lab-<id>)");
  assert.match(d, /equals\s*=\s*"Microsoft\.KeyVault\/vaults"/, "it governs Key Vaults");
  assert.match(d, /effect\s*=\s*"deployIfNotExists"/, "deployIfNotExists");
  assert.match(d, /type\s*=\s*"Microsoft\.Insights\/diagnosticSettings"/, "it looks for, and deploys, a diagnostic setting");
  assert.match(d, /"allLogs"/, "sending allLogs");
  // The roles its assignment's identity needs (ruling 28): exactly Monitoring Contributor, a built-in on the allow-list.
  const roles = strings(list(d, "roleDefinitionIds"));
  assert.deepEqual(roles, [`/providers/Microsoft.Authorization/roleDefinitions/${MONITORING_CONTRIBUTOR}`]);
  assert.ok(ALLOWED_ROLES.builtIn.some((b) => b.id === MONITORING_CONTRIBUTOR && b.name === "Monitoring Contributor"));
  // Never Log Analytics Contributor (identity change 1 is contingent) and never at subscription scope.
  assert.doesNotMatch(d, /92aaf0da-9dab-42b6-94a3-d43ce8d16293/);
  assert.doesNotMatch(d, /deploymentScope/i, "deploys into the vault's own group (the default)");
  // The rule is known at plan: the workspace comes in as a parameter, never as a reference.
  assert.doesNotMatch(d, /azurerm_log_analytics_workspace\./, "the workspace id is a parameter, given by the assignment");
  assert.match(d, /parameters\('logAnalytics'\)/);
});

test(`${MON}: its assignment at rg-lab-<id> has a system identity holding exactly that role at rg-lab-<id>`, () => {
  const l = lab(MON);
  const def = dine(l);
  const ws = one(l, "azurerm_log_analytics_workspace");
  const as = resources(l, "azurerm_resource_group_policy_assignment");
  const a = as.find((x) => attr(x.body, "policy_definition_id") === `azurerm_policy_definition.${def.labels[1]}.id`);
  assert.ok(a, "the DINE definition is assigned");
  assert.equal(attr(a.body, "name"), '"lab-${var.lab_id}-kv-diagnostics"');
  assert.equal(attr(a.body, "resource_group_id"), "azurerm_resource_group.lab.id", "assigned at rg-lab-<id>, never the subscription");
  assert.equal(attr(nested(a.body, "identity"), "type"), '"SystemAssigned"');
  assert.equal(attr(a.body, "location"), "var.region", "an assignment with an identity needs a location");
  assert.match(a.body, new RegExp(`logAnalytics\\s*=\\s*\\{\\s*value\\s*=\\s*azurerm_log_analytics_workspace\\.${ws.labels[1]}\\.id`), "the workspace, as a parameter");
  // Exactly one role assignment in the lab: Monitoring Contributor at the group, to that identity.
  const ras = resources(l, "azurerm_role_assignment");
  assert.equal(ras.length, 1);
  const ra = ras[0].body;
  assert.equal(attr(ra, "role_definition_name"), '"Monitoring Contributor"');
  assert.equal(attr(ra, "scope"), "azurerm_resource_group.lab.id");
  assert.equal(attr(ra, "principal_id"), `azurerm_resource_group_policy_assignment.${a.labels[1]}.identity[0].principal_id`);
  assert.equal(attr(ra, "principal_type"), '"ServicePrincipal"');
  assert.equal(attr(ra, "skip_service_principal_aad_check"), "true", "the identity is brand new (replication lag)");
  // And the built-in audit: Resource logs in Key Vault should be enabled.
  const audit = as.find((x) => policyIdOf(l, x.body).endsWith("cf820ca0-f99e-4f3e-84fb-66e913812d21"));
  assert.ok(audit, "the built-in AuditIfNotExists is assigned");
  assert.equal(attr(audit.body, "name"), '"lab-${var.lab_id}-kv-logs-audit"');
  assert.equal(attr(audit.body, "resource_group_id"), "azurerm_resource_group.lab.id");
  assert.equal(nested(audit.body, "identity"), undefined, "an audit needs no identity");
  assert.equal(as.length, 2, "two assignments");
});

test(`${MON}: the vault is created after the assignment and its role, with no purge protection`, () => {
  const l = lab(MON);
  const kv = one(l, "azurerm_key_vault");
  const a = resources(l, "azurerm_resource_group_policy_assignment").find((x) => attr(x.body, "name") === '"lab-${var.lab_id}-kv-diagnostics"');
  const ra = one(l, "azurerm_role_assignment");
  const deps = list(kv.body, "depends_on") ?? "";
  assert.match(deps, new RegExp(`azurerm_resource_group_policy_assignment\\.${a.labels[1]}\\b`), "after the assignment: policy evaluates the new vault and remediates it");
  assert.match(deps, new RegExp(`azurerm_role_assignment\\.${ra.labels[1]}\\b`), "after the identity's role, so the deployment is allowed");
  assert.equal(attr(kv.body, "purge_protection_enabled"), "false", "ruling 30: purge protection would keep the vault for its whole retention");
  assert.equal(attr(kv.body, "soft_delete_retention_days"), "7");
  assert.equal(attr(kv.body, "sku_name"), '"standard"');
  assert.equal(attr(kv.body, "rbac_authorization_enabled"), "true");
  assert.match(attr(kv.body, "name"), /^"\$\{var\.name_prefix\}[a-z0-9]+"$/, "a fresh name each session");
  const kvf = nested(features(l), "key_vault");
  assert.ok(kvf !== undefined, "features has a key_vault block");
  assert.equal(attr(kvf, "purge_soft_delete_on_destroy"), "true");
  assert.equal(attr(kvf, "recover_soft_deleted_key_vaults"), "false");
  // No diagnostic setting of the lab's own: policy makes it.
  assert.deepEqual(resources(l).filter((r) => /diagnostic_setting/.test(r.labels[0])).map((r) => r.labels.join(".")), []);
});

test(`${MON}: the readme says diagnostics arrive about 15 minutes after deploy`, () => {
  const r = lab(MON).readme;
  assert.match(r, /about 15 minutes/);
  assert.match(r, /Monitoring Contributor/);
  assert.match(r, /remediation task/i);
  assert.match(r, /AzureDiagnostics/);
});

// ── Lab 22: Key Vault and managed identities ─────────────────────────────

const KV = "az305-22-keyvault-mi";

labContentSuite(KV, { marker: "£", identity: "match" });

test(`${KV}: an RBAC Key Vault with 7-day retention and no purge protection`, () => {
  const kv = one(lab(KV), "azurerm_key_vault").body;
  assert.equal(attr(kv, "name"), '"${var.name_prefix}kv"');
  assert.equal(attr(kv, "sku_name"), '"standard"');
  assert.equal(attr(kv, "rbac_authorization_enabled"), "true", "Azure RBAC, not access policies");
  assert.equal(attr(kv, "public_network_access_enabled"), "true", "the VM reaches it on its public endpoint, over default outbound access");
  assert.equal(attr(kv, "soft_delete_retention_days"), "7");
  assert.equal(attr(kv, "purge_protection_enabled"), "false", "ruling 30: purge protection would keep the vault for its whole retention");
  assert.equal(attr(kv, "tenant_id"), "data.azurerm_client_config.current.tenant_id");
  assert.equal(nested(kv, "access_policy"), undefined, "no access policies");
});

test(`${KV}: the VM has a system identity and the user-assigned identity`, () => {
  const l = lab(KV);
  const uai = one(l, "azurerm_user_assigned_identity");
  assert.equal(attr(uai.body, "name"), '"id-${var.name_prefix}-app"');
  const vm = one(l, "azurerm_linux_virtual_machine").body;
  const id = nested(vm, "identity");
  assert.equal(attr(id, "type"), '"SystemAssigned, UserAssigned"');
  assert.equal(attr(id, "identity_ids"), `[azurerm_user_assigned_identity.${uai.labels[1]}.id]`);
  assert.equal(attr(vm, "size"), '"Standard_B1s"');
});

test(`${KV}: Secrets User for the VM at the vault and for the user-assigned identity at one secret only`, () => {
  const l = lab(KV);
  const kv = one(l, "azurerm_key_vault");
  const vm = one(l, "azurerm_linux_virtual_machine");
  const uai = one(l, "azurerm_user_assigned_identity");
  const secret = named(l, "azurerm_key_vault_secret", '"reports-api-key"');
  const ras = resources(l, "azurerm_role_assignment").map((r) => ({
    role: attr(r.body, "role_definition_name"),
    scope: attr(r.body, "scope"),
    principal: attr(r.body, "principal_id"),
    type: attr(r.body, "principal_type"),
  }));
  const key = (r) => `${r.role} | ${r.scope} | ${r.principal} | ${r.type}`;
  assert.deepEqual(
    ras.map(key).sort(),
    [
      { role: '"Key Vault Secrets Officer"', scope: `azurerm_key_vault.${kv.labels[1]}.id`, principal: "data.azurerm_client_config.current.object_id", type: '"ServicePrincipal"' },
      { role: '"Key Vault Secrets User"', scope: `azurerm_key_vault.${kv.labels[1]}.id`, principal: `azurerm_linux_virtual_machine.${vm.labels[1]}.identity[0].principal_id`, type: '"ServicePrincipal"' },
      { role: '"Key Vault Secrets User"', scope: `azurerm_key_vault_secret.${secret.labels[1]}.resource_versionless_id`, principal: `azurerm_user_assigned_identity.${uai.labels[1]}.principal_id`, type: '"ServicePrincipal"' },
    ]
      .map(key)
      .sort(),
    "Officer for the pipeline and Secrets User for the VM at the vault; Secrets User for the user-assigned identity at reports-api-key only",
  );
  // The suite's view: all three at resource scope.
  assert.deepEqual(roleAssignments(l).map((r) => r.scope), ["resource", "resource", "resource"]);
});

test(`${KV}: the secrets wait for the pipeline's Officer assignment`, () => {
  const l = lab(KV);
  const officer = resources(l, "azurerm_role_assignment").find((r) => attr(r.body, "role_definition_name") === '"Key Vault Secrets Officer"');
  const wait = one(l, "time_sleep");
  assert.equal(attr(wait.body, "create_duration"), '"120s"', "two minutes for the data-plane role to reach the vault");
  assert.match(list(wait.body, "depends_on") ?? "", new RegExp(`azurerm_role_assignment\\.${officer.labels[1]}\\b`));
  const secrets = resources(l, "azurerm_key_vault_secret");
  assert.deepEqual(secrets.map((s) => attr(s.body, "name")).sort(), ['"app-db-password"', '"reports-api-key"']);
  const passwords = resources(l, "random_password").map((p) => p.labels[1]);
  for (const s of secrets) {
    assert.match(list(s.body, "depends_on") ?? "", new RegExp(`time_sleep\\.${wait.labels[1]}\\b`), `${attr(s.body, "name")} waits (and is destroyed before the Officer assignment goes)`);
    const value = /^random_password\.([A-Za-z0-9_]+)\.result$/.exec(attr(s.body, "value") ?? "");
    assert.ok(value && passwords.includes(value[1]), `${attr(s.body, "name")}: a random_password, never a literal`);
  }
  // A lab using time and random says so (labs/_template pins neither).
  const req = nested(l.blocks.find((b) => b.kind === "terraform").body, "required_providers");
  assert.match(req, /time\s*=\s*\{[^}]*source\s*=\s*"hashicorp\/time"/);
  assert.match(req, /random\s*=\s*\{[^}]*source\s*=\s*"hashicorp\/random"/);
});

test(`${KV}: versions.tf purges the vault on destroy and never recovers one`, () => {
  const kvf = nested(features(lab(KV)), "key_vault");
  assert.ok(kvf !== undefined, "features has a key_vault block");
  assert.equal(attr(kvf, "purge_soft_delete_on_destroy"), "true");
  assert.equal(attr(kvf, "purge_soft_deleted_secrets_on_destroy"), "false", "secrets go with the purged vault");
  assert.equal(attr(kvf, "recover_soft_deleted_key_vaults"), "false");
});

test(`${KV}: the subnet sets default outbound access on`, () => {
  const l = lab(KV);
  const subnet = one(l, "azurerm_subnet").body;
  assert.equal(attr(subnet, "default_outbound_access_enabled"), "true", "ruling 37: the VM reaches the vault's public endpoint over default outbound access");
  assert.deepEqual(resources(l).filter((r) => /nat_gateway|public_ip/.test(r.labels[0])).map((r) => r.labels.join(".")), []);
});
