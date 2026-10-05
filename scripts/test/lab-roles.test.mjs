// lab-roles.test.mjs
//
// Plain English: labs/setup/allowed-roles.json is the allow-list both the
// scope check and the Azure ABAC condition read, by GUID. A mistyped GUID
// would silently allow nothing (or something else), so each one is checked:
// well formed, unique, never a dangerous role, and each built-in equal to
// Azure's published id (Microsoft's "Azure built-in roles" page; checked
// 2026-10-04, see the L1 report).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ALLOWED_ROLES, LAB_ID_RE } from "../lib/labs.mjs";
import { allowedRolesProblems } from "../labs-setup.mjs";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Azure's fixed ids for the built-in roles on the §8.1 allow-list. */
const AZURE_BUILT_IN = {
  Reader: "acdd72a7-3385-48ef-bd42-f606fba81ae7",
  Contributor: "b24988ac-6180-42a0-ab88-20f7382dd24c",
  "Storage Blob Data Reader": "2a2b9908-6ea1-4ae2-8e65-a410df84e7d1",
  "Storage Blob Data Contributor": "ba92f5b4-2d11-453d-a403-e96b0029c9fe",
  "Virtual Machine Contributor": "9980e02c-c2be-4d73-94e8-173b1dc7cf3c",
  "Key Vault Secrets User": "4633458b-17de-408a-b874-0445c86b69e6",
  "Key Vault Secrets Officer": "b86a8fe4-44ce-4948-aee5-eccb2c155cd7",
  "Monitoring Reader": "43d0d8ad-25c7-4714-9337-8ba259a9fe05",
  "Monitoring Contributor": "749f88d5-cbae-40b8-bcfc-e573ddc772fa",
  "Network Contributor": "4d97b98b-1d4f-4787-a291-c67834d212e7",
  "Backup Operator": "00c29273-979b-4161-815c-10b084fb9324",
};
/** Roles that can hand out access: never on the list (spec §8.1). */
const FORBIDDEN = {
  Owner: "8e3af657-a8ff-443c-a75c-2fe8c4bcb635",
  "User Access Administrator": "18d7d88d-d35e-4fb5-a5c3-7773c20a72d9",
  "Role Based Access Control Administrator": "f58310d9-a9f6-439a-9e8d-f62e7b41a168",
};

test("allowed-roles.json: every GUID is well formed, lower case and unique", () => {
  const ids = [...ALLOWED_ROLES.builtIn, ...ALLOWED_ROLES.custom].map((r) => r.id);
  for (const id of ids) assert.match(id, GUID, id);
  assert.equal(new Set(ids).size, ids.length, "a GUID is listed twice");
  const names = [...ALLOWED_ROLES.builtIn, ...ALLOWED_ROLES.custom].map((r) => r.name);
  assert.equal(new Set(names).size, names.length, "a role name is listed twice");
  assert.deepEqual(allowedRolesProblems(ALLOWED_ROLES), []);
});

test("allowed-roles.json: each built-in role carries Azure's own id, and the list is exactly the §8.1 roles", () => {
  assert.deepEqual(Object.fromEntries(ALLOWED_ROLES.builtIn.map((r) => [r.name, r.id])), AZURE_BUILT_IN);
});

test("allowed-roles.json: never Owner, User Access Administrator or RBAC Administrator, by name or id", () => {
  const all = [...ALLOWED_ROLES.builtIn, ...ALLOWED_ROLES.custom];
  for (const [name, id] of Object.entries(FORBIDDEN)) {
    assert.ok(!all.some((r) => r.name === name || r.id === id), name);
  }
});

test("allowed-roles.json: custom roles are lab-<lab>- named, belong to a real lab id, and use random (v4) GUIDs", () => {
  for (const r of ALLOWED_ROLES.custom) {
    assert.match(r.lab, LAB_ID_RE);
    assert.ok(r.name.startsWith(`lab-${r.lab}-`), r.name);
    assert.match(r.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, `${r.name}: a fixed custom-role id should be a random v4 GUID`);
  }
  assert.deepEqual(ALLOWED_ROLES.principalTypes, ["User", "Group", "ServicePrincipal"]);
});

test("allowedRolesProblems refuses a malformed GUID, a duplicate GUID, a forbidden role and a badly named custom role", () => {
  const good = JSON.parse(readFileSync(new URL("../../labs/setup/allowed-roles.json", import.meta.url), "utf8"));
  const bad = (mutate) => {
    const x = structuredClone(good);
    mutate(x);
    return allowedRolesProblems(x);
  };
  assert.ok(bad((x) => (x.builtIn[0].id = "acdd72a7-3385-48ef-bd42-f606fba81ae")).some((p) => /malformed/.test(p)));
  assert.ok(bad((x) => (x.builtIn[0].id = "ACDD72A7-3385-48EF-BD42-F606FBA81AE7")).some((p) => /malformed/.test(p)));
  assert.ok(bad((x) => (x.builtIn[1].id = x.builtIn[0].id)).some((p) => /twice/.test(p)));
  assert.ok(bad((x) => x.builtIn.push({ name: "Owner", id: FORBIDDEN.Owner })).some((p) => /never/.test(p)));
  assert.ok(bad((x) => (x.custom[0].name = "vm-operator")).some((p) => /lab-/.test(p)));
});
