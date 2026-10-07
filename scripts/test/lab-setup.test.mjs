// lab-setup.test.mjs
//
// Plain English: the one-time identity setup files for labs (spec §8.1-8.2):
// the custom role JSON Steven pastes into the portal, the ABAC condition
// built from allowed-roles.json, "npm run labs-setup" (which fills in the
// subscription id and prints only file names), and the new LAB_UPN_DOMAIN
// secret.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALLOWED_ROLES } from "../lib/labs.mjs";
import { conditionText, GOVERNANCE_ACTIONS, setup } from "../labs-setup.mjs";
import { buildGithubSecrets, OPTIONAL_GITHUB_MAP } from "../lib/secrets-map.mjs";

const SETUP = new URL("../../labs/setup/", import.meta.url);
const role = JSON.parse(readFileSync(new URL("governance-role.json", SETUP), "utf8"));
const condition = readFileSync(new URL("governance-condition.txt", SETUP), "utf8").replace(/\r\n/g, "\n");
const FAKE_SUB = "0f0f0f0f-1234-4abc-8def-0123456789ab";

test("governance-role.json is the §8.1 custom role, assignable only at the subscription it is created in", () => {
  assert.equal(role.properties.roleName, "wg-admin labs governance");
  assert.deepEqual(role.properties.assignableScopes, ["/subscriptions/{subscriptionId}"]);
  assert.deepEqual(role.properties.permissions[0].actions, GOVERNANCE_ACTIONS);
  for (const a of [
    "Microsoft.Authorization/roleAssignments/write",
    "Microsoft.Authorization/roleAssignments/delete",
    "Microsoft.Authorization/roleDefinitions/write",
    "Microsoft.Authorization/roleDefinitions/delete",
    "Microsoft.Authorization/policyDefinitions/*",
    "Microsoft.Authorization/policySetDefinitions/*",
    "Microsoft.Authorization/policyAssignments/*",
    "Microsoft.Authorization/policyExemptions/*",
    "Microsoft.Authorization/locks/*",
    "Microsoft.Management/managementGroups/read",
    "Microsoft.Management/managementGroups/write",
    "Microsoft.Management/managementGroups/delete",
  ]) assert.ok(GOVERNANCE_ACTIONS.includes(a), a);
  assert.equal(GOVERNANCE_ACTIONS.length, 12);
  assert.ok(!GOVERNANCE_ACTIONS.some((a) => a === "*" || a.startsWith("Microsoft.Authorization/*")));
  assert.deepEqual(role.properties.permissions[0].notActions, []);
});

test("governance-condition.txt is built from allowed-roles.json: every allowed GUID, the three principal types, both write and delete", () => {
  assert.equal(condition, conditionText(ALLOWED_ROLES));
  for (const r of [...ALLOWED_ROLES.builtIn, ...ALLOWED_ROLES.custom]) assert.ok(condition.includes(r.id), r.name);
  for (const t of ALLOWED_ROLES.principalTypes) assert.ok(condition.includes(`'${t}'`), t);
  assert.match(condition, /ActionMatches\{'Microsoft\.Authorization\/roleAssignments\/write'\}/);
  assert.match(condition, /ActionMatches\{'Microsoft\.Authorization\/roleAssignments\/delete'\}/);
  assert.match(condition, /@Request\[Microsoft\.Authorization\/roleAssignments:RoleDefinitionId\] ForAnyOfAnyValues:GuidEquals \{/);
  assert.match(condition, /@Resource\[Microsoft\.Authorization\/roleAssignments:RoleDefinitionId\] ForAnyOfAnyValues:GuidEquals \{/);
  for (const forbidden of ["8e3af657-a8ff-443c-a75c-2fe8c4bcb635", "18d7d88d-d35e-4fb5-a5c3-7773c20a72d9", "f58310d9-a9f6-439a-9e8d-f62e7b41a168"]) assert.ok(!condition.includes(forbidden));
  // Balanced parentheses and braces, as the portal's code view needs.
  for (const [o, c] of [["(", ")"], ["{", "}"]]) assert.equal(condition.split(o).length, condition.split(c).length);
});

// Identity change 2 (labs batch 3 plan; approved by Steven 2026-10-05): lab 20 assigns its custom roles, so the
// condition allows them. Steven re-applies it on the governance role assignment before lab 20's release test.
test("governance-condition.txt allows lab 20's two custom roles, to write and to delete an assignment", () => {
  for (const id of ["60bdbc03-b25a-4a83-9fce-b2c5afff563c", "bd52e05a-22cb-4bd5-b56c-3396add9b7c0"]) assert.equal(condition.split(id).length - 1, 2, id);
  // The full list, in allowed-roles.json's order: the twelve built-ins (AcrPull last, identity change 3), then lab 1's
  // role and lab 20's two.
  const list = /@Request\[Microsoft\.Authorization\/roleAssignments:RoleDefinitionId\] ForAnyOfAnyValues:GuidEquals \{([^}]*)\}/.exec(condition)[1].split(", ");
  assert.equal(list.length, 15);
  assert.equal(list[11], "7f951dda-4ed3-4680-a7ca-43fe172d538d", "AcrPull");
  assert.deepEqual(list.slice(-3), ["7331dcae-09d3-477e-8da7-2895697f0fc0", "60bdbc03-b25a-4a83-9fce-b2c5afff563c", "bd52e05a-22cb-4bd5-b56c-3396add9b7c0"]);
});

test("labs-setup substitutes the subscription id and never prints it", () => {
  const dir = mkdtempSync(join(tmpdir(), "labs-setup-"));
  const lines = [];
  const files = setup({ subscriptionId: FAKE_SUB, dir, log: (l) => lines.push(l) });
  assert.deepEqual(files.map((f) => f.split(/[\\/]/).pop()).sort(), ["governance-condition.local.txt", "governance-role.local.json"]);
  const local = JSON.parse(readFileSync(join(dir, "governance-role.local.json"), "utf8"));
  assert.deepEqual(local.properties.assignableScopes, [`/subscriptions/${FAKE_SUB}`]);
  assert.ok(!JSON.stringify(local).includes("{subscriptionId}"));
  assert.equal(readFileSync(join(dir, "governance-condition.local.txt"), "utf8"), conditionText(ALLOWED_ROLES));
  const printed = lines.join("\n");
  assert.ok(!printed.includes(FAKE_SUB), "the subscription id was printed");
  assert.match(printed, /governance-role\.local\.json/);
  assert.throws(() => setup({ subscriptionId: "", dir, log: () => {} }), /AZURE_SUBSCRIPTION_ID/);
  assert.throws(() => setup({ subscriptionId: "REPLACE_ME", dir, log: () => {} }), /AZURE_SUBSCRIPTION_ID/);
});

test("the README's 'Labs: one-time setup' has the §8.2 steps, Cloud Shell, the Graph role ids and the management-group setting", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const start = readme.indexOf("## Labs: one-time setup");
  assert.ok(start > 0);
  const section = readme.slice(start, readme.indexOf("\n## ", start + 5)).replace(/\s+/g, " ");
  for (const s of ["npm run labs-setup", "Add custom role", "Allow user to only assign selected roles", "User.ReadWrite.All", "User.DeleteRestore.All", "Group.ReadWrite.All", "Grant admin consent", "LAB_UPN_DOMAIN", "Check permissions", "Cloud Shell", "az ad sp show --id $GRAPH", "GRAPH=00000003-0000-0000-c000-000000000000", "Require write permissions for creating new management groups", "--check", "--confirm-cost"]) {
    assert.ok(section.includes(s), s);
  }
});

test("LAB_UPN_DOMAIN goes to GitHub when set, and a blank one is skipped without failing the gateway's secrets", () => {
  assert.equal(OPTIONAL_GITHUB_MAP.LAB_UPN_DOMAIN, "LAB_UPN_DOMAIN");
  const env = { LAB_UPN_DOMAIN: "contoso.onmicrosoft.com" };
  assert.equal(buildGithubSecrets(env).secrets.LAB_UPN_DOMAIN, "contoso.onmicrosoft.com");
  assert.ok(!buildGithubSecrets(env).errors.some((e) => e.includes("LAB_UPN_DOMAIN")));
  const blank = buildGithubSecrets({ LAB_UPN_DOMAIN: "" });
  assert.ok(!("LAB_UPN_DOMAIN" in blank.secrets));
  assert.ok(!blank.errors.some((e) => e.includes("LAB_UPN_DOMAIN")));
  assert.ok(!("LAB_UPN_DOMAIN" in buildGithubSecrets({ LAB_UPN_DOMAIN: "REPLACE_ME_domain" }).secrets));
  assert.match(readFileSync(new URL("../../.env.example", import.meta.url), "utf8"), /^LAB_UPN_DOMAIN=$/m);
});
