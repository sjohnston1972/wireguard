// lab-cleanup.test.mjs
//
// Plain English: the lab pipeline's bash steps that talk to Azure, run for
// real in bash against a pretend az (fixtures/labs/harness.mjs records every
// call): unblock (what stops a resource group delete), the safety net and its
// clean check (what gets a lab back to £0 when Terraform cannot), peering to
// the gateway and back, and the ready check. Skipped where bash is missing
// (CI's Ubuntu runner has it; so does Git Bash on Windows).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { BASH, firstCall, fwd, lastCall, REPO, world } from "./fixtures/labs/harness.mjs";

const skip = BASH ? false : "no bash found";
const ID = "az104-06-blob-security";
const RG = `rg-lab-${ID}`;
const SUB = "00000000-0000-0000-0000-000000000000";
const GW_VNET = `/subscriptions/${SUB}/resourceGroups/rg-wg-ondemand/providers/Microsoft.Network/virtualNetworks/vnet-wg`;
const LAB_VNET = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Network/virtualNetworks/vnet-lab`;
/** Every resource group a subscription might hold: the lab's two, and four it must never touch. */
const GROUPS = [RG, `${RG}-nodes`, `${RG}x`, "rg-lab-az104-07-files", "NetworkWatcherRG", "rg-wg-ondemand"].join("\n");

for (const f of ["lab-unblock.sh", "lab-safety-net.sh", "lab-peer.sh", "lab-ready.sh", "lab-state-reset.sh"]) {
  test(`${f} passes bash -n`, { skip }, () => {
    const r = spawnSync(BASH, ["-n", fwd(join(REPO, "infra", "ci", f))], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });
}

test("every script refuses a lab id that fails the pattern before calling Azure", { skip }, () => {
  const w = world([{ match: "^group list", out: GROUPS }]);
  for (const [script, args] of [
    ["infra/ci/lab-unblock.sh", ["bad id"]],
    ["infra/ci/lab-safety-net.sh", [""]],
    ["infra/ci/lab-safety-net.sh", ["--verify", "az104-06-x--y"]],
    ["infra/ci/lab-peer.sh", ["peer", "../etc"]],
    ["infra/ci/lab-ready.sh", ["az104-6-short", "2"]],
  ]) {
    const r = w.run(script, args);
    assert.notEqual(r.status, 0, `${script} ${args.join(" ")}`);
  }
  assert.deepEqual(w.calls().filter((c) => c.startsWith("az ")), []);
  w.cleanup();
});

// ── Unblock ──────────────────────────────────────────────────────────────

test("unblock removes locks, legal holds, unlocked immutability, backup protection and replication in that order", { skip }, () => {
  const w = world([
    { match: "^group list", out: GROUPS },
    { match: `^lock list --resource-group ${RG} `, out: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Authorization/locks/nodelete\n/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Storage/storageAccounts/sa1/providers/Microsoft.Authorization/locks/sa-lock` },
    { match: `^storage account list --resource-group ${RG} `, out: "l06k3x9qsa" },
    { match: "^storage container-rm list .*hasLegalHold", out: "held" },
    { match: "^storage container legal-hold show .*--container-name held", out: "case1\ncase2" },
    { match: "^storage container-rm list .*hasImmutabilityPolicy", out: "worm\nlocked" },
    { match: "^storage container immutability-policy show .*--container-name worm", out: "Unlocked\t\"0x8D\"" },
    { match: "^storage container immutability-policy show .*--container-name locked", out: "Locked\t\"0x9E\"" },
    { match: `^backup vault list --resource-group ${RG} `, out: "rsv-lab" },
    { match: "^backup item list .*isScheduledForDeferredDelete", out: "/subscriptions/x/item-soft" },
    { match: "^backup item list", out: "/subscriptions/x/item-1\n/subscriptions/x/item-soft" },
    { match: "^rest --method get --url .*replicationProtectedItems", out: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.RecoveryServices/vaults/rsv-lab/replicationFabrics/f/replicationProtectionContainers/c/replicationProtectedItems/vm1` },
  ]);
  const r = w.run("infra/ci/lab-unblock.sh", [ID]);
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  const order = [
    firstCall(calls, /^az lock delete --ids .*locks\/nodelete/),
    firstCall(calls, /^az storage container legal-hold clear .*--container-name held .*--tags case1 case2/),
    firstCall(calls, /^az storage container immutability-policy delete .*--container-name worm .*--if-match "0x8D"/),
    firstCall(calls, /^az backup vault backup-properties set .*--soft-delete-feature-state Disable/),
    firstCall(calls, /^az backup protection undelete --ids \/subscriptions\/x\/item-soft/),
    firstCall(calls, /^az backup protection disable --ids \/subscriptions\/x\/item-1 --delete-backup-data true --yes/),
    firstCall(calls, /^az rest --method post --url .*replicationProtectedItems\/vm1\/remove/),
  ];
  for (const i of order) assert.ok(i >= 0, `missing call; calls were:\n${calls.join("\n")}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, `out of order:\n${calls.join("\n")}`);
  assert.equal(lastCall(calls, /^az lock delete/) < order[1], true, "every lock goes before the first legal hold");
  // A Locked policy cannot be removed: it is reported, never "deleted".
  assert.equal(firstCall(calls, /immutability-policy delete .*--container-name locked/), -1);
  assert.match(r.out, /locked.*Locked/i);
  // Only the lab's own groups.
  for (const c of calls) assert.ok(!/rg-lab-az104-06-blob-securityx|rg-lab-az104-07|NetworkWatcherRG|rg-wg-ondemand/.test(c.replace(/^az group list.*/, "")), c);
  w.cleanup();
});

// Lab 19's vault, as unblock finds it (labs batch 2 plan, B0.5).
const L19 = "az104-19-backup";
const R19 = `rg-lab-${L19}`;
const VAULT = [
  { match: "^group list", out: `${R19}\n${R19}-irp1\nrg-lab-az104-07-files` },
  { match: `^backup vault list --resource-group ${R19} `, out: "rsv-lab" },
];
const ITEM_VM = `/subscriptions/${SUB}/resourceGroups/${R19}/providers/Microsoft.RecoveryServices/vaults/rsv-lab/backupFabrics/Azure/protectionContainers/iaasvmcontainerv2;${R19};vm-app/protectedItems/vm;iaasvmcontainerv2;${R19};vm-app`;

test("unblock turns an unlocked vault's immutability off before soft delete, and warns on a locked one", { skip }, () => {
  const w = world([...VAULT, { match: "^backup vault show .*immutabilitySettings", out: "Unlocked" }, { match: "^backup item list", out: "" }]);
  const r = w.run("infra/ci/lab-unblock.sh", [L19]);
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  const show = firstCall(calls, /^az backup vault show --name rsv-lab --resource-group rg-lab-az104-19-backup --query properties\.securitySettings\.immutabilitySettings\.state -o tsv$/);
  const off = firstCall(calls, /^az backup vault update --name rsv-lab --resource-group rg-lab-az104-19-backup --immutability-state Disabled -o none$/);
  const soft = firstCall(calls, /^az backup vault backup-properties set --name rsv-lab .*--soft-delete-feature-state Disable/);
  assert.ok(show >= 0 && off > show && soft > off, `immutability off, then soft delete off:\n${calls.join("\n")}`);
  assert.match(r.out, /rsv-lab: unlocked immutability turned off/);
  w.cleanup();

  // Locked: nothing can turn it off. Said loudly, never "updated", and the run still ends 0.
  const l = world([...VAULT, { match: "^backup vault show .*immutabilitySettings", out: "Locked" }, { match: "^backup item list", out: "" }]);
  const lr = l.run("infra/ci/lab-unblock.sh", [L19]);
  assert.equal(lr.status, 0, lr.out);
  assert.equal(firstCall(l.calls(), /^az backup vault update/), -1);
  assert.match(lr.out, /::warning::unblock: rsv-lab: immutability is LOCKED/);
  // Disabled (or a vault that cannot be read): nothing to do.
  const d = world([...VAULT, { match: "^backup vault show", out: "Disabled" }, { match: "^backup item list", out: "" }]);
  assert.equal(d.run("infra/ci/lab-unblock.sh", [L19]).status, 0);
  assert.equal(firstCall(d.calls(), /^az backup vault update/), -1);
  l.cleanup();
  d.cleanup();
});

test("unblock stops protection for backup items of every management type", { skip }, () => {
  // `az backup item list` with no --backup-management-type sends no filter, so it lists every type (az 2.86, checked).
  const items = [
    [ITEM_VM, "AzureIaasVM", "VM"],
    [`/subscriptions/${SUB}/resourceGroups/${R19}/providers/Microsoft.RecoveryServices/vaults/rsv-lab/backupFabrics/Azure/protectionContainers/storagecontainer;Storage;${R19};l19k3x9qsa/protectedItems/AzureFileShare;labshare`, "AzureStorage", "AzureFileShare"],
    [`/subscriptions/${SUB}/resourceGroups/${R19}/providers/Microsoft.RecoveryServices/vaults/rsv-lab/backupFabrics/Azure/protectionContainers/vmappcontainer;compute;${R19};vm-sql/protectedItems/sqldatabase;mssqlserver;labdb`, "AzureWorkload", "SQLDataBase"],
    [`/subscriptions/${SUB}/resourceGroups/${R19}/providers/Microsoft.RecoveryServices/vaults/rsv-lab/backupFabrics/Azure/protectionContainers/mab;agent/protectedItems/mab;files`, "MAB", "FileFolder"],
  ];
  const w = world([...VAULT, { match: "^backup item list .*\\[\\]\\.\\[id", out: [items.map((i) => i.join("\t")).join("\n"), ""] }, { match: "^backup item list", out: "" }]);
  const r = w.run("infra/ci/lab-unblock.sh", [L19]);
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  // Listed once, without a type filter, asking for each item's type.
  const list = calls.find((c) => /^az backup item list .*\[\]\.\[id/.test(c));
  assert.doesNotMatch(list, /--backup-management-type/);
  const disables = calls.filter((c) => c.startsWith("az backup protection disable"));
  assert.deepEqual(disables, items.slice(0, 3).map(([id, bmt, wt]) => `az backup protection disable --ids ${id} --delete-backup-data true --yes --backup-management-type ${bmt} --workload-type ${wt} -o none`));
  // An agent (MAB) item cannot be stopped from the CLI: a warning names it.
  assert.match(r.out, /::warning::unblock: rsv-lab: .*mab;files.*MAB/);
  w.cleanup();
});

test("unblock waits until a vault has no backup items, at most five minutes", { skip }, () => {
  // Deleting backup data takes Azure a while: the vault lists the item until it is gone.
  const gone = world([...VAULT, { match: "^backup item list .*\\[\\]\\.\\[id", out: `${ITEM_VM}\tAzureIaasVM\tVM` }, { match: "^backup item list .*--query \\[\\]\\.id ", out: [ITEM_VM, ITEM_VM, ""] }]);
  const r = gone.run("infra/ci/lab-unblock.sh", [L19]);
  assert.equal(r.status, 0, r.out);
  const sleeps = gone.calls().filter((c) => c.startsWith("sleep "));
  assert.deepEqual(sleeps, ["sleep 15", "sleep 15"]);
  assert.match(r.out, /rsv-lab: no backup items left/);
  // Still there after the wait (default 300 s): a warning, and the run goes on to destroy.
  const stuck = world([...VAULT, { match: "^backup item list .*\\[\\]\\.\\[id", out: `${ITEM_VM}\tAzureIaasVM\tVM` }, { match: "^backup item list .*--query \\[\\]\\.id ", out: ITEM_VM }]);
  const s = stuck.run("infra/ci/lab-unblock.sh", [L19]);
  assert.equal(s.status, 0, s.out);
  const waited = stuck.calls().filter((c) => c.startsWith("sleep ")).reduce((n, c) => n + Number(c.split(" ")[1]), 0);
  assert.ok(waited <= 300 && waited >= 285, `waited ${waited} s`);
  assert.match(s.out, /::warning::unblock: rsv-lab: 1 backup item\(s\) still listed after 300 s/);
  assert.match(s.out, /unblock: done/);
  // The wait is configurable (a release test may want longer), still bounded.
  const short = world([...VAULT, { match: "^backup item list .*\\[\\]\\.\\[id", out: `${ITEM_VM}\tAzureIaasVM\tVM` }, { match: "^backup item list .*--query \\[\\]\\.id ", out: ITEM_VM }]);
  short.run("infra/ci/lab-unblock.sh", [L19], { LAB_UNBLOCK_VAULT_WAIT_SECONDS: "30" });
  assert.deepEqual(short.calls().filter((c) => c.startsWith("sleep ")), ["sleep 15", "sleep 15"]);
  for (const x of [gone, stuck, short]) x.cleanup();
});

test("unblock deletes Azure Files share snapshots (lab 7): a share with snapshots cannot be destroyed", { skip }, () => {
  const L7 = "az104-07-files";
  const R7 = `rg-lab-${L7}`;
  const w = world([
    { match: "^group list", out: `${R7}\nrg-lab-az104-06-blob-security` },
    { match: `^storage account list --resource-group ${R7} `, out: "l07k3x9qfiles" },
    { match: "^storage share-rm list .*--include-snapshot", out: "labshare\t2026-10-05T09:10:00.0000000Z\nlabshare\t2026-10-05T09:40:00.0000000Z" },
    { match: "^backup vault list", out: "" },
  ]);
  const r = w.run("infra/ci/lab-unblock.sh", [L7]);
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  const list = calls.find((c) => c.startsWith("az storage share-rm list"));
  assert.match(list, new RegExp(`--storage-account l07k3x9qfiles --resource-group ${R7} --include-snapshot`));
  const dels = calls.filter((c) => c.startsWith("az storage share-rm delete"));
  assert.deepEqual(dels, [
    `az storage share-rm delete --storage-account l07k3x9qfiles --resource-group ${R7} --name labshare --snapshot 2026-10-05T09:10:00.0000000Z --yes -o none`,
    `az storage share-rm delete --storage-account l07k3x9qfiles --resource-group ${R7} --name labshare --snapshot 2026-10-05T09:40:00.0000000Z --yes -o none`,
  ]);
  // The share itself is Terraform's to delete.
  assert.ok(!calls.some((c) => c.startsWith("az storage share-rm delete") && !c.includes("--snapshot")));
  w.cleanup();
});

test("unblock never fails the run, even when Azure refuses", { skip }, () => {
  const w = world([
    { match: "^group list", out: RG },
    { match: "^lock list", out: "/x/locks/a" },
    { match: "^lock delete", code: 1, err: "AuthorizationFailed" },
  ]);
  const r = w.run("infra/ci/lab-unblock.sh", [ID]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /::warning::/);
  w.cleanup();
});

// ── Safety net ───────────────────────────────────────────────────────────

const ENTRA = [
  { match: "^ad user list .*userPrincipalName,'lab-az104-06-blob-security-'", out: `u-ann\tlab-${ID}-ann@contoso.onmicrosoft.com\tlab-${ID}-ann\nu-x\tlab-${ID}x-bob@contoso.onmicrosoft.com\tlab-${ID}x-bob` },
  { match: "^ad user list .*displayName,'lab-az104-06-blob-security-'", out: `u-ann\tlab-${ID}-ann@contoso.onmicrosoft.com\tlab-${ID}-ann\nu-steven\tsteven@contoso.onmicrosoft.com\tSteven` },
  { match: "^ad group list", out: `g-readers\tlab-${ID}-readers\ng-other\tlab-az104-07-files-readers` },
];

test("safety net deletes rg-lab-<id> and rg-lab-<id>-* and lab-<id>- Entra objects when terraform destroy failed and state is missing", { skip }, () => {
  const w = world([{ match: "^group list", out: GROUPS }, { match: "^account show", out: SUB }, ...ENTRA]);
  // No terraform state, no terraform at all: the safety net works from Azure's own lists.
  const r = w.run("infra/ci/lab-safety-net.sh", [ID], { TF_STATE_MISSING: "1" });
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  assert.ok(calls.includes(`az group delete --name ${RG} --yes --no-wait`), calls.join("\n"));
  assert.ok(calls.includes(`az group delete --name ${RG}-nodes --yes --no-wait`));
  assert.ok(firstCall(calls, new RegExp(`^az group wait --deleted --name ${RG} `)) > firstCall(calls, new RegExp(`^az group delete --name ${RG} `)));
  assert.ok(calls.includes("az ad user delete --id u-ann"));
  assert.ok(firstCall(calls, /^az rest --method delete --url https:\/\/graph\.microsoft\.com\/v1\.0\/directory\/deletedItems\/u-ann/) > calls.indexOf("az ad user delete --id u-ann"), "then purged from the recycle bin, so the next deploy can reuse the name");
  assert.ok(calls.includes("az ad group delete --group g-readers"));
  assert.equal(calls.filter((c) => c.startsWith("terraform")).length, 0);
  w.cleanup();
});

test("safety net never touches rg-lab-<id>x, another lab or NetworkWatcherRG", { skip }, () => {
  const w = world([{ match: "^group list", out: GROUPS }, { match: "^account show", out: SUB }, ...ENTRA]);
  w.run("infra/ci/lab-safety-net.sh", [ID]);
  const deletes = w.calls().filter((c) => / delete /.test(c) || / wait /.test(c));
  for (const c of deletes) assert.ok(!/rg-lab-az104-06-blob-securityx|rg-lab-az104-07-files|NetworkWatcherRG|rg-wg-ondemand|u-x|u-steven|g-other/.test(c), c);
  w.cleanup();
});

test("governance safety net deletes custom roles, policy assignments and definitions, then management groups children first", { skip }, () => {
  const G = "az104-03-mgmt-groups";
  const MG = (n) => `/providers/Microsoft.Management/managementGroups/${n}`;
  const w = world([
    { match: "^group list", out: `rg-lab-${G}` },
    { match: "^account show", out: SUB },
    { match: "^role definition list", out: `7331dcae-0000-4000-8000-000000000001\tlab-${G}-operator\t/subscriptions/${SUB}\nb24988ac-6180-42a0-ab88-20f7382dd24c\tContributor\t/` },
    { match: "^role assignment list .*--role 7331dcae-0000-4000-8000-000000000001", out: "/subscriptions/x/providers/Microsoft.Authorization/roleAssignments/ra1" },
    { match: "^account management-group list", out: `lab-${G}-root\tlab-${G}-root\nlab-${G}-prod\tlab-${G}-prod\nlab-${G}-prod-eu\tlab-${G}-prod-eu\nsteven-root\tSteven` },
    { match: `^account management-group show --name lab-${G}-root `, out: "00000000-tenant-root" },
    { match: `^account management-group show --name lab-${G}-prod `, out: `lab-${G}-root` },
    { match: `^account management-group show --name lab-${G}-prod-eu `, out: `lab-${G}-prod` },
    { match: `^policy assignment list --scope ${MG(`lab-${G}-root`)} `, out: `${MG(`lab-${G}-root`)}/providers/Microsoft.Authorization/policyAssignments/lab-az104-03-audit` },
    { match: "^policy assignment list --disable-scope-strict-match", out: `/subscriptions/${SUB}/providers/Microsoft.Authorization/policyAssignments/lab-${G}-tags\tlab-${G}-tags\tlab-${G}-tags\n/subscriptions/${SUB}/providers/Microsoft.Authorization/policyAssignments/steven-baseline\tsteven-baseline\tBaseline` },
    { match: "^policy set-definition list --query", out: `lab-${G}-initiative\tlab-${G}-initiative` },
    { match: `^policy definition list --management-group lab-${G}-root `, out: `lab-${G}-audit-tags\tlab-${G}-audit-tags` },
    { match: "^policy definition list --query", out: `lab-${G}-require-tag\tlab-${G}-require-tag\nallowed-locations-custom\tAllowed locations (Steven)` },
  ]);
  const r = w.run("infra/ci/lab-safety-net.sh", [G]);
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  const at = (re) => {
    const i = firstCall(calls, re);
    assert.ok(i >= 0, `${re} missing; calls:\n${calls.join("\n")}`);
    return i;
  };
  const steps = [
    at(/^az role assignment delete --ids .*roleAssignments\/ra1/),
    at(/^az role definition delete --name 7331dcae-0000-4000-8000-000000000001/),
    at(/^az policy assignment delete --name lab-az104-03-audit --scope \/providers\/Microsoft\.Management\/managementGroups\/lab-az104-03-mgmt-groups-root/),
    at(/^az policy assignment delete --name lab-az104-03-mgmt-groups-tags /),
    at(/^az policy set-definition delete --name lab-az104-03-mgmt-groups-initiative/),
    at(/^az policy definition delete --name lab-az104-03-mgmt-groups-require-tag/),
    at(/^az policy definition delete --name lab-az104-03-mgmt-groups-audit-tags --management-group lab-az104-03-mgmt-groups-root/),
    at(/^az account management-group delete --name lab-az104-03-mgmt-groups-prod-eu/),
    at(/^az account management-group delete --name lab-az104-03-mgmt-groups-prod$/),
    at(/^az account management-group delete --name lab-az104-03-mgmt-groups-root$/),
  ];
  // Roles before policy, assignments before definitions, definitions before groups, children before parents.
  assert.ok(steps[1] < steps[2] && steps[3] < steps[4] && steps[4] < steps[5] && steps[6] < steps[7] && steps[7] < steps[8] && steps[8] < steps[9], calls.join("\n"));
  for (const c of calls) assert.ok(!/delete.*(Contributor|b24988ac|steven-baseline|allowed-locations-custom|steven-root)/.test(c), c);
  w.cleanup();
});

test("lab 1 with its Terraform state gone: the safety net asks for the lab's fixed custom role GUIDs directly and deletes the role", { skip }, () => {
  const L1 = "az104-01-identity";
  const GUID = "7331dcae-09d3-477e-8da7-2895697f0fc0";
  const ROLE_URL = `/subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${GUID}`;
  const w = world([
    { match: "^group list", out: `rg-lab-${L1}` },
    { match: "^account show", out: SUB },
    // The subscription-level listing does not show a role assignable only inside rg-lab-<id>.
    { match: "^role definition list", out: "b24988ac-6180-42a0-ab88-20f7382dd24c\tContributor\t/" },
    { match: `^rest --method get --url ${ROLE_URL}`, out: `${GUID}\tlab-${L1}-vm-operator\t/subscriptions/${SUB}/resourceGroups/rg-lab-${L1}` },
    { match: `^role assignment list .*--role ${GUID}`, out: `/subscriptions/${SUB}/resourceGroups/rg-lab-${L1}/providers/Microsoft.Authorization/roleAssignments/ra1` },
  ]);
  // No terraform state, no terraform at all.
  const r = w.run("infra/ci/lab-safety-net.sh", [L1], { TF_STATE_MISSING: "1" });
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  const get = firstCall(calls, new RegExp(`^az rest --method get --url ${ROLE_URL}`));
  const ra = firstCall(calls, /^az role assignment delete --ids .*roleAssignments\/ra1/);
  const del = firstCall(calls, new RegExp(`^az role definition delete --name ${GUID} --scope /subscriptions/${SUB}`));
  assert.ok(get >= 0 && ra > get && del > ra, calls.join("\n"));
  assert.equal(calls.filter((c) => c.startsWith("terraform")).length, 0);
  w.cleanup();

  // The clean check asks the same way: still there is a leftover; gone (404) is clean; an unreadable answer is not clean.
  const verify = (rule) => {
    const v = world([{ match: "^group list", out: "" }, { match: "^account show", out: SUB }, { match: "^role definition list", out: "" }, { match: `^rest --method get --url ${ROLE_URL}`, ...rule }]);
    const res = v.run("infra/ci/lab-safety-net.sh", ["--verify", L1]);
    v.cleanup();
    return res;
  };
  const still = verify({ out: `${GUID}\tlab-${L1}-vm-operator\t/subscriptions/${SUB}/resourceGroups/rg-lab-${L1}` });
  assert.equal(still.status, 1, still.out);
  assert.deepEqual(JSON.parse(/^leftovers=(.*)$/m.exec(still.stdout)[1]), [`lab-${L1}-vm-operator`]);
  const gone = verify({ code: 3, err: "ERROR: (RoleDefinitionDoesNotExist) The specified role definition with ID '7331dcae' does not exist." });
  assert.equal(gone.status, 0, gone.out);
  assert.match(gone.stdout, /^clean=true$/m);
  const unknown = verify({ code: 1, err: "ERROR: (AuthorizationFailed) The client does not have authorization" });
  assert.equal(unknown.status, 1, unknown.out);
  assert.match(unknown.stdout, /unverified: custom role lab-az104-01-identity-vm-operator/);
});

test("the safety net reads every lab's fixed custom role GUIDs from allowed-roles.json", { skip }, () => {
  const roles = JSON.parse(readFileSync(join(REPO, "labs", "setup", "allowed-roles.json"), "utf8")).custom;
  assert.ok(roles.length > 0);
  for (const c of roles) {
    const w = world([{ match: "^group list", out: "" }, { match: "^account show", out: SUB }]);
    w.run("infra/ci/lab-safety-net.sh", ["--verify", c.lab]);
    assert.ok(w.calls().some((x) => x.startsWith(`az rest --method get --url /subscriptions/${SUB}/providers/Microsoft.Authorization/roleDefinitions/${c.id}?`)), `${c.lab}: ${c.id}`);
    w.cleanup();
  }
  // A lab with none asks for none.
  const w = world([{ match: "^group list", out: "" }, { match: "^account show", out: SUB }]);
  w.run("infra/ci/lab-safety-net.sh", ["--verify", ID]);
  assert.ok(!w.calls().some((x) => /roleDefinitions\//.test(x)));
  w.cleanup();
});

test("verify clean prints clean=false and the leftovers", { skip }, () => {
  const out = join(mkdtempSync(join(tmpdir(), "gho-")), "out");
  writeFileSync(out, "");
  const w = world([
    { match: "^group list", out: `${RG}\n${RG}x\nNetworkWatcherRG` },
    { match: "^account show", out: SUB },
    { match: "^ad user list .*userPrincipalName", out: `u-ann\tlab-${ID}-ann@contoso.onmicrosoft.com\tlab-${ID}-ann` },
  ]);
  const r = w.run("infra/ci/lab-safety-net.sh", ["--verify", ID], { GITHUB_OUTPUT: fwd(out) });
  assert.equal(r.status, 1, r.out);
  assert.match(r.stdout, /^clean=false$/m);
  const written = readFileSync(out, "utf8");
  assert.match(written, /^clean=false$/m);
  const left = JSON.parse(/^leftovers=(.*)$/m.exec(written)[1]);
  assert.deepEqual(left.sort(), [RG, `lab-${ID}-ann`].sort());
  // Names only: never the tenant domain from a sign-in name.
  assert.ok(!written.includes("contoso"));
  // No deletes in verify mode.
  assert.equal(w.calls().filter((c) => / delete /.test(c)).length, 0);
  w.cleanup();
});

test("verify clean prints clean=true when nothing is left, and clean=false when Azure cannot be listed", { skip }, () => {
  const w = world([{ match: "^group list", out: `${RG}x\nNetworkWatcherRG` }, { match: "^account show", out: SUB }]);
  const r = w.run("infra/ci/lab-safety-net.sh", ["--verify", ID]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /^clean=true$/m);
  assert.match(r.stdout, /^leftovers=\[\]$/m);
  w.cleanup();
  const broken = world([{ match: "^group list", code: 1, err: "AuthorizationFailed" }, { match: "^account show", out: SUB }]);
  const b = broken.run("infra/ci/lab-safety-net.sh", ["--verify", ID]);
  assert.equal(b.status, 1);
  assert.match(b.stdout, /^clean=false$/m);
  assert.match(b.stdout, /unverified/);
  broken.cleanup();
});

// Live 2026-10-05: in a tenant that has never used management groups, wg-admin's
// identity gets AuthorizationFailed listing them. It owns every group it creates,
// so a refusal means none of the lab's exist: clean, not "unverified".
test("verify clean: a management-group list refused with AuthorizationFailed counts as none, any other failure stays unverified", { skip }, () => {
  const refused = world([
    { match: "^group list", out: `${RG}x\nNetworkWatcherRG` },
    { match: "^account show", out: SUB },
    { match: "^account management-group list", code: 1, err: "ERROR: (AuthorizationFailed) The client does not have authorization to perform action 'Microsoft.Management/managementGroups/read'" },
  ]);
  const a = refused.run("infra/ci/lab-safety-net.sh", ["--verify", ID]);
  assert.equal(a.status, 0, a.out);
  assert.match(a.stdout, /^clean=true$/m);
  assert.match(a.out, /no management groups visible/);
  refused.cleanup();
  const down = world([
    { match: "^group list", out: `${RG}x\nNetworkWatcherRG` },
    { match: "^account show", out: SUB },
    { match: "^account management-group list", code: 1, err: "ERROR: (InternalServerError) try again later" },
  ]);
  const b = down.run("infra/ci/lab-safety-net.sh", ["--verify", ID]);
  assert.equal(b.status, 1, b.out);
  assert.match(b.stdout, /unverified: management groups/);
  down.cleanup();
});

// ── Peering ──────────────────────────────────────────────────────────────

const PEER_ENV = { LAB_PEER_URL: "https://wg-admin.example.net/api/callback/lab-peer", CALLBACK_TOKEN: "tok-123456", WORKER_RUN_ID: "lab-deploy-1-abc" };
/** The Worker's begin answer: { go } plus, when go, whether this run may link DNS zones (labs/callbacks.ts dnsLinkFor). */
const peerWorld = (go = true, begin = go ? { go, dns_link: true } : { go }) =>
  world([
    { cmd: "curl", match: "phase\":\"begin", out: JSON.stringify(begin) },
    { cmd: "curl", match: "phase\":\"end", out: "{\"ok\":true}" },
    { match: "^network vnet show --resource-group rg-wg-ondemand --name vnet-wg", out: GW_VNET },
    { match: `^network vnet list --resource-group ${RG} `, out: LAB_VNET },
    { match: "^network vnet peering show", code: 3, err: "ResourceNotFound" },
    { match: `^network private-dns zone list --resource-group ${RG} `, out: "privatelink.blob.core.windows.net" },
  ]);

test("peer creates both sides with the §7.6 flags and links private DNS zones only with dns_link", { skip }, () => {
  const w = peerWorld();
  const r = w.run("infra/ci/lab-peer.sh", ["peer", ID], { ...PEER_ENV, DNS_LINK: "true" });
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  const lab = calls.find((c) => c.startsWith("az network vnet peering create") && c.includes(`--resource-group ${RG} `));
  const gw = calls.find((c) => c.startsWith("az network vnet peering create") && c.includes("--resource-group rg-wg-ondemand "));
  assert.ok(lab && gw, calls.join("\n"));
  assert.match(lab, /--vnet-name vnet-lab/);
  assert.match(lab, new RegExp(`--remote-vnet ${GW_VNET}`));
  assert.match(lab, /--allow-vnet-access/);
  assert.match(lab, /--allow-forwarded-traffic/);
  assert.match(gw, /--vnet-name vnet-wg/);
  assert.match(gw, new RegExp(`--name lab-${ID}( |$)`));
  assert.match(gw, new RegExp(`--remote-vnet ${LAB_VNET}`));
  assert.match(gw, /--allow-vnet-access/);
  assert.doesNotMatch(gw, /--allow-forwarded-traffic|--allow-gateway-transit|--use-remote-gateways/);
  const link = calls.find((c) => c.startsWith("az network private-dns link vnet create"));
  assert.ok(link, "a DNS link");
  assert.match(link, new RegExp(`--resource-group ${RG} --zone-name privatelink\\.blob\\.core\\.windows\\.net`));
  assert.match(link, new RegExp(`--virtual-network ${GW_VNET}`));
  assert.match(link, /--registration-enabled false/);
  // A privatelink zone linked to vnet-wg must not hide every other account's public name.
  assert.match(link, /--resolution-policy NxDomainRedirect/);
  // Begin first, end last, both with the run's token.
  const begin = firstCall(calls, /^curl .*"phase":"begin"/);
  const end = firstCall(calls, /^curl .*"phase":"end","ok":true/);
  assert.ok(begin >= 0 && end > calls.indexOf(gw) && begin < calls.indexOf(lab), calls.join("\n"));
  assert.match(calls[begin], /Authorization: Bearer tok-123456/);
  w.cleanup();

  const noLink = peerWorld();
  noLink.run("infra/ci/lab-peer.sh", ["peer", ID], { ...PEER_ENV, DNS_LINK: "false" });
  assert.equal(firstCall(noLink.calls(), /private-dns link vnet create/), -1);
  noLink.cleanup();
});

test("peer: only privatelink zones get NxDomainRedirect (Azure takes it only there)", { skip }, () => {
  const w = world([
    { cmd: "curl", match: "phase\":\"begin", out: JSON.stringify({ go: true, dns_link: true }) },
    { cmd: "curl", match: "phase\":\"end", out: "{\"ok\":true}" },
    { match: "^network vnet show --resource-group rg-wg-ondemand --name vnet-wg", out: GW_VNET },
    { match: `^network vnet list --resource-group ${RG} `, out: LAB_VNET },
    { match: "^network vnet peering show", code: 3, err: "ResourceNotFound" },
    { match: `^network private-dns zone list --resource-group ${RG} `, out: "privatelink.file.core.windows.net\ncontoso.internal" },
  ]);
  const r = w.run("infra/ci/lab-peer.sh", ["peer", ID], { ...PEER_ENV, DNS_LINK: "true" });
  assert.equal(r.status, 0, r.out);
  const links = w.calls().filter((c) => c.startsWith("az network private-dns link vnet create"));
  assert.equal(links.length, 2, w.calls().join("\n"));
  assert.match(links.find((c) => c.includes("privatelink.file")), /--resolution-policy NxDomainRedirect/);
  assert.doesNotMatch(links.find((c) => c.includes("contoso.internal")), /--resolution-policy/);
  w.cleanup();
});

test("peer skips the DNS links when the Worker's begin answer says dns_link false, and says why", { skip }, () => {
  // Another peered lab already linked a zone of the same name to vnet-wg; Azure would refuse a second.
  const note = "Private DNS zones not linked: Lab 7 has linked its zones to the gateway's VNet";
  const w = peerWorld(true, { go: true, dns_link: false, note });
  const r = w.run("infra/ci/lab-peer.sh", ["peer", ID], { ...PEER_ENV, DNS_LINK: "true" });
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  assert.ok(calls.some((c) => c.startsWith("az network vnet peering create")), "still peers");
  assert.equal(firstCall(calls, /private-dns link vnet create/), -1, calls.join("\n"));
  assert.match(r.out, /not linked/i);
  assert.ok(firstCall(calls, /^curl .*"phase":"end","ok":true/) >= 0, "the peering itself is ok");
  w.cleanup();
  // An answer with no dns_link at all never links either.
  const bare = peerWorld(true, { go: true });
  bare.run("infra/ci/lab-peer.sh", ["peer", ID], { ...PEER_ENV, DNS_LINK: "true" });
  assert.equal(firstCall(bare.calls(), /private-dns link vnet create/), -1);
  bare.cleanup();
});

test("peer waits when the Worker says wait, and skips without a Worker", { skip }, () => {
  const w = peerWorld(false);
  const r = w.run("infra/ci/lab-peer.sh", ["peer", ID], { ...PEER_ENV, DNS_LINK: "true" });
  assert.equal(r.status, 0, r.out);
  assert.equal(firstCall(w.calls(), /peering create/), -1);
  assert.equal(firstCall(w.calls(), /"phase":"end"/), -1, "no lock was taken, so none is released");
  assert.match(r.out, /wait/i);
  w.cleanup();
  const solo = peerWorld();
  const s = solo.run("infra/ci/lab-peer.sh", ["peer", ID], { DNS_LINK: "true" });
  assert.equal(s.status, 0);
  assert.equal(firstCall(solo.calls(), /peering create|^curl/), -1);
  solo.cleanup();
});

test("peer tells the Worker it failed and releases the lock when a peering cannot be made", { skip }, () => {
  const w = world([
    { cmd: "curl", match: "phase\":\"begin", out: "{\"go\":true}" },
    { match: "^network vnet show --resource-group rg-wg-ondemand --name vnet-wg", out: GW_VNET },
    { match: `^network vnet list --resource-group ${RG} `, out: LAB_VNET },
    { match: "^network vnet peering show", code: 3 },
    { match: "^network vnet peering create .*rg-wg-ondemand", code: 1, err: "Conflict" },
  ]);
  const r = w.run("infra/ci/lab-peer.sh", ["peer", ID], { ...PEER_ENV, DNS_LINK: "false" });
  assert.equal(r.status, 0, r.out);
  assert.ok(firstCall(w.calls(), /^curl .*"phase":"end","ok":false/) >= 0, w.calls().join("\n"));
  w.cleanup();
});

test("unpeer deletes the vnet-wg side first", { skip }, () => {
  const w = world([
    { match: "^network vnet show --resource-group rg-wg-ondemand --name vnet-wg", out: GW_VNET },
    { match: "^network vnet peering list --resource-group rg-wg-ondemand --vnet-name vnet-wg", out: `lab-${ID}\nlab-az104-07-files\nhome-site` },
    { match: `^group exists --name ${RG}`, out: "true" },
    { match: `^network vnet list --resource-group ${RG} `, out: LAB_VNET },
    { match: `^network vnet peering list --resource-group ${RG} --vnet-name vnet-lab`, out: `lab-${ID}-to-wg` },
    { match: `^network private-dns zone list --resource-group ${RG} `, out: "privatelink.blob.core.windows.net" },
    { match: "^network private-dns link vnet list", out: `lab-${ID}-wg\nlocal-link` },
  ]);
  const r = w.run("infra/ci/lab-peer.sh", ["unpeer", ID]);
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  const gw = firstCall(calls, new RegExp(`^az network vnet peering delete --resource-group rg-wg-ondemand --vnet-name vnet-wg --name lab-${ID}$`));
  const lab = firstCall(calls, new RegExp(`^az network vnet peering delete --resource-group ${RG} --vnet-name vnet-lab --name lab-${ID}-to-wg`));
  const link = firstCall(calls, new RegExp(`^az network private-dns link vnet delete --resource-group ${RG} --zone-name privatelink.blob.core.windows.net --name lab-${ID}-wg`));
  assert.ok(gw >= 0 && lab > gw && link > gw, calls.join("\n"));
  for (const c of calls) assert.ok(!/delete.*(lab-az104-07-files|home-site|local-link)/.test(c), c);
  w.cleanup();
});

test("unpeer is idempotent: no gateway VNet and no lab group is a clean no-op", { skip }, () => {
  const w = world([
    { match: "^network vnet show", code: 3, err: "ResourceNotFound" },
    { match: "^group exists", out: "false" },
  ]);
  const r = w.run("infra/ci/lab-peer.sh", ["unpeer", ID]);
  assert.equal(r.status, 0, r.out);
  assert.equal(firstCall(w.calls(), / delete /), -1);
  w.cleanup();
});

// ── Ready check ──────────────────────────────────────────────────────────

test("ready check polls until every provisioningState is Succeeded or deploy_min passes", { skip }, () => {
  const w = world([
    { match: "^group list", out: `${RG}\tSucceeded\n${RG}x\tCreating` },
    { match: `^resource list --resource-group ${RG} `, out: [`vnet-lab\tUpdating\nl06sa\tSucceeded`, `vnet-lab\tUpdating\nl06sa\tSucceeded`, `vnet-lab\tSucceeded\nl06sa\tSucceeded`] },
  ]);
  const r = w.run("infra/ci/lab-ready.sh", [ID, "4"], { LAB_READY_INTERVAL: "0" });
  assert.equal(r.status, 0, r.out);
  assert.equal(w.calls().filter((c) => c.startsWith(`az resource list --resource-group ${RG} `)).length, 3);
  assert.match(r.out, /ready/i);
  w.cleanup();

  const stuck = world([
    { match: "^group list", out: `${RG}\tSucceeded` },
    { match: `^resource list --resource-group ${RG} `, out: `vnet-lab\tFailed` },
  ]);
  const s = stuck.run("infra/ci/lab-ready.sh", [ID, "4"], { LAB_READY_INTERVAL: "0", LAB_READY_SECONDS: "0" });
  assert.equal(s.status, 1);
  assert.match(s.out, /vnet-lab.*Failed/);
  stuck.cleanup();

  const none = world([{ match: "^group list", out: "" }]);
  const n = none.run("infra/ci/lab-ready.sh", [ID, "4"], { LAB_READY_INTERVAL: "0", LAB_READY_SECONDS: "0" });
  assert.equal(n.status, 1, "no lab group is not ready");
  none.cleanup();
});
