// labs-content-identity.test.mjs
//
// Plain English: the content checks for labs 1-4 (plan area L5): identity,
// policy, management groups and cost. labs-check already checks lab.yaml and
// the readme rules; this file checks what each lab's Terraform actually
// builds, from the text alone (no Azure, no terraform init): everything sits
// in rg-lab-<id> or is a governance object named lab-<id>-..., nothing is
// assigned at subscription scope, Entra names carry the prefix, the custom
// role keeps its fixed GUID, and each lab makes what the plan says it makes.
// terraform fmt -check runs when terraform is on PATH (CI has it).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWED_ROLES, buildCatalogue, LAB_TF_VARS, lintTfText, parseLabYaml, variablesProblems } from "../lib/labs.mjs";

const labsDir = fileURLToPath(new URL("../../labs/", import.meta.url));
const LABS = ["az104-01-identity"];

// ── A small HCL reader: enough for these labs' own text ──────────────────

/** Blank out # and // comments (outside strings) so they never match. */
function stripComments(src) {
  return src
    .split("\n")
    .map((line) => {
      let inStr = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === "\\" && inStr) i++;
        else if (c === '"') inStr = !inStr;
        else if (!inStr && (c === "#" || (c === "/" && line[i + 1] === "/"))) return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/** Every top-level block `kind "type" "name" { ... }` with its body. */
function blocks(src, kind) {
  const code = stripComments(src);
  const out = [];
  const re = new RegExp(`^${kind}\\s+"([^"]+)"(?:\\s+"([^"]+)")?\\s*\\{`, "gm");
  for (const m of code.matchAll(re)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < code.length; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}" && --depth === 0) break;
    }
    out.push({ type: m[1], name: m[2] ?? null, body: code.slice(m.index + m[0].length, i) });
  }
  return out;
}

/** The right-hand side of `key = ...` (first match, any depth). */
const attr = (body, key) => body.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, "m"))?.[1] ?? null;

function lab(id) {
  const dir = join(labsDir, id, "terraform");
  const files = existsSync(dir) ? Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".tf")).map((f) => [f, readFileSync(join(dir, f), "utf8")])) : {};
  const all = Object.values(files).join("\n");
  const yaml = parseLabYaml(readFileSync(join(labsDir, id, "lab.yaml"), "utf8")).raw;
  const readme = readFileSync(join(labsDir, id, "readme.md"), "utf8");
  return { dir, files, all, yaml, readme, resources: blocks(all, "resource"), data: blocks(all, "data"), outputs: blocks(all, "output") };
}

const of = (l, type) => l.resources.filter((r) => r.type === type);
const one = (l, type, name) => {
  const r = l.resources.find((x) => x.type === type && (name === undefined || x.name === name));
  assert.ok(r, `${type}${name ? `.${name}` : ""} is missing`);
  return r;
};

// Resource types that take tags in these labs; each must carry var.tags.
const TAGGABLE = ["azurerm_resource_group", "azurerm_storage_account", "azurerm_network_security_group", "azurerm_monitor_action_group"];
// Never in a lab: they reach the subscription or move it (spec §8.3).
const SUBSCRIPTION_TYPES = [
  "azurerm_subscription_policy_assignment",
  "azurerm_subscription_policy_exemption",
  "azurerm_subscription_policy_remediation",
  "azurerm_management_group_subscription_association",
  "azurerm_consumption_budget_subscription",
  "azurerm_subscription",
];

// ── Every lab ────────────────────────────────────────────────────────────

const { catalogue, problems } = buildCatalogue(labsDir);

for (const id of LABS) {
  test(`${id}: labs-check passes and the readme is in the catalogue`, () => {
    assert.deepEqual(problems.filter((p) => p.lab === id), []);
    assert.ok(catalogue.labs.some((d) => d.id === id));
    assert.ok(catalogue.readmes[id]?.length);
  });

  test(`${id}: has the four Terraform files, lint-clean, declaring only used §3.4 variables`, () => {
    const l = lab(id);
    for (const f of ["versions.tf", "variables.tf", "outputs.tf", "main.tf"]) assert.ok(l.files[f], `terraform/${f} is missing`);
    assert.deepEqual(lintTfText(l.files), []);
    assert.deepEqual(variablesProblems(l.files["variables.tf"]), []);
    const declared = blocks(l.files["variables.tf"], "variable").map((b) => b.type);
    for (const v of declared) {
      assert.ok(LAB_TF_VARS.includes(v));
      const elsewhere = Object.entries(l.files).filter(([f]) => f !== "variables.tf").map(([, t]) => stripComments(t)).join("\n");
      assert.match(elsewhere, new RegExp(`\\bvar\\.${v}\\b`), `variable ${v} is declared but never used`);
    }
    for (const t of ["private_ips", "connect"]) assert.ok(l.outputs.some((o) => o.type === t), `output ${t} is missing`);
  });

  test(`${id}: one resource group, named by the pipeline, and everything else inside it`, () => {
    const l = lab(id);
    const rgs = of(l, "azurerm_resource_group");
    assert.equal(rgs.length, 1);
    assert.equal(rgs[0].name, "lab");
    assert.equal(attr(rgs[0].body, "name"), "var.resource_group_name");
    for (const r of l.resources) {
      const rgName = attr(r.body, "resource_group_name");
      if (rgName) assert.equal(rgName, "azurerm_resource_group.lab.name", `${r.type}.${r.name}`);
      const rgId = attr(r.body, "resource_group_id");
      if (rgId) assert.equal(rgId, "azurerm_resource_group.lab.id", `${r.type}.${r.name}`);
      if (TAGGABLE.includes(r.type)) assert.match(r.body, /\bvar\.tags\b/, `${r.type}.${r.name} needs var.tags`);
    }
  });

  test(`${id}: nothing is assigned, locked or budgeted at subscription scope`, () => {
    const l = lab(id);
    for (const t of SUBSCRIPTION_TYPES) assert.equal(of(l, t).length, 0, `${t} is not allowed in a lab`);
    for (const r of [...of(l, "azurerm_role_assignment"), ...of(l, "azurerm_management_lock")]) {
      const scope = attr(r.body, "scope");
      assert.ok(scope && !/subscription/i.test(scope), `${r.type}.${r.name} scope ${scope} must be inside the lab`);
    }
    for (const r of of(l, "azurerm_management_group")) assert.equal(attr(r.body, "subscription_ids"), null, "a lab never moves the subscription");
  });

  test(`${id}: Entra and governance names start lab-<id>-`, () => {
    const l = lab(id);
    const prefixed = (v) => typeof v === "string" && v.startsWith('"lab-${var.lab_id}-');
    for (const r of l.resources.filter((x) => x.type.startsWith("azuread_"))) {
      for (const k of ["display_name", "user_principal_name", "mail_nickname"]) {
        const v = attr(r.body, k);
        if (v !== null) assert.ok(prefixed(v), `${r.type}.${r.name} ${k} = ${v}`);
      }
      assert.ok(attr(r.body, "display_name"), `${r.type}.${r.name} needs a display_name`);
    }
    for (const t of ["azurerm_role_definition", "azurerm_policy_definition", "azurerm_policy_set_definition", "azurerm_management_group"]) {
      for (const r of of(l, t)) assert.ok(prefixed(attr(r.body, "name")), `${t}.${r.name} name = ${attr(r.body, "name")}`);
    }
  });

  test(`${id}: lab.yaml identity matches the Terraform`, () => {
    const l = lab(id);
    const creates = [...(of(l, "azuread_user").length ? ["user"] : []), ...(of(l, "azuread_group").length ? ["group"] : [])];
    assert.deepEqual([...l.yaml.identity.creates].sort(), creates.sort());
    assert.equal(of(l, "azurerm_role_assignment").length, l.yaml.identity.roles.length);
    const builtIn = new Set(ALLOWED_ROLES.builtIn.map((b) => b.name));
    for (const r of of(l, "azurerm_role_assignment")) {
      const byName = attr(r.body, "role_definition_name");
      if (byName) assert.ok(builtIn.has(JSON.parse(byName)), `${r.name}: ${byName} is not an allowed built-in role`);
      else assert.match(attr(r.body, "role_definition_id") ?? "", /^azurerm_role_definition\.\w+\.role_definition_resource_id$/);
      assert.ok(attr(r.body, "principal_type"), `${r.name} sets principal_type (no replication race)`);
    }
    if (l.yaml.identity.creates.includes("user")) assert.ok(l.outputs.some((o) => o.type === "users"), "a lab with users outputs users");
  });

  test(`${id}: the readme has a text diagram and only Microsoft Learn links`, () => {
    const l = lab(id);
    assert.match(l.readme, /## What it deploys[\s\S]*```text\n[\s\S]+?\n```[\s\S]*## Things to try/);
    const links = [...l.readme.matchAll(/\]\((https:[^)]+)\)/g)].map((m) => m[1]);
    assert.ok(links.length >= 2, "at least two Learn links");
    for (const u of links) assert.match(u, /^https:\/\/learn\.microsoft\.com\/(azure|entra|credentials)\//);
    assert.doesNotMatch(l.readme, /This readme is a stub/);
  });

  test(`${id}: terraform fmt -check`, { skip: spawnSync("terraform", ["version"]).status === 0 ? false : "terraform is not on PATH" }, () => {
    const r = spawnSync("terraform", ["fmt", "-check", "-diff", "-no-color"], { cwd: lab(id).dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
}

// ── Lab 1: users, groups, roles and custom roles ─────────────────────────

test("lab 1: ann and ben sign in with the session password; ann alone is in helpdesk", () => {
  const l = lab("az104-01-identity");
  for (const who of ["ann", "ben"]) {
    const u = one(l, "azuread_user", who);
    assert.equal(attr(u.body, "user_principal_name"), `"lab-\${var.lab_id}-${who}@\${var.upn_domain}"`);
    assert.equal(attr(u.body, "display_name"), `"lab-\${var.lab_id}-${who}"`);
    assert.equal(attr(u.body, "password"), "var.admin_password");
    assert.equal(attr(u.body, "force_password_change"), "false");
  }
  const g = one(l, "azuread_group", "helpdesk");
  assert.equal(attr(g.body, "display_name"), '"lab-${var.lab_id}-helpdesk"');
  assert.equal(attr(g.body, "security_enabled"), "true");
  assert.equal(attr(g.body, "members"), "[azuread_user.ann.object_id]");
});

test("lab 1: the custom role keeps its fixed GUID and is assignable only at the lab's group", () => {
  const l = lab("az104-01-identity");
  const fixed = ALLOWED_ROLES.custom.find((c) => c.lab === "az104-01-identity");
  const role = one(l, "azurerm_role_definition", "vm_operator");
  assert.equal(attr(role.body, "role_definition_id"), `"${fixed.id}"`);
  assert.equal(attr(role.body, "name"), '"lab-${var.lab_id}-vm-operator"');
  assert.equal(attr(role.body, "assignable_scopes"), "[azurerm_resource_group.lab.id]");
  assert.match(role.body, /Microsoft\.Compute\/virtualMachines\/start\/action/);
  assert.doesNotMatch(role.body, /"\*"|Microsoft\.Authorization\/\*/, "no wildcard or authorization actions");
});

test("lab 1: Reader for the group and the custom role for ben, both at the resource group", () => {
  const l = lab("az104-01-identity");
  const reader = one(l, "azurerm_role_assignment", "helpdesk_reader");
  assert.equal(attr(reader.body, "role_definition_name"), '"Reader"');
  assert.equal(attr(reader.body, "principal_id"), "azuread_group.helpdesk.object_id");
  assert.equal(attr(reader.body, "principal_type"), '"Group"');
  assert.equal(attr(reader.body, "scope"), "azurerm_resource_group.lab.id");
  const ben = one(l, "azurerm_role_assignment", "ben_vm_operator");
  assert.equal(attr(ben.body, "role_definition_id"), "azurerm_role_definition.vm_operator.role_definition_resource_id");
  assert.equal(attr(ben.body, "principal_id"), "azuread_user.ben.object_id");
  assert.equal(attr(ben.body, "principal_type"), '"User"');
  assert.equal(attr(ben.body, "scope"), "azurerm_resource_group.lab.id");
});

test("lab 1: the readme warns about MFA registration", () => {
  assert.match(lab("az104-01-identity").readme, /MFA|multifactor/i);
});
