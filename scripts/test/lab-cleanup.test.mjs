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

test("unblock removes locks, legal holds, unlocked immutability, backup protection, replication and SQL links in that order", { skip }, () => {
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
    { match: "^rest --method get --url .*replicationProtectedItems\\?.*value\\[\\]\\.\\[id", out: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.RecoveryServices/vaults/rsv-lab/replicationFabrics/f/replicationProtectionContainers/c/replicationProtectedItems/vm1\tNone` },
    // SQL (batch 3): a failover group and its geo-link to a server in the lab's other group.
    { match: `^sql server list --resource-group ${RG} `, out: "sql1" },
    { match: `^sql server list --resource-group ${RG}-nodes `, out: "sql2" },
    { match: `^sql failover-group list --resource-group ${RG} --server sql1 `, out: "fog1\tPrimary" },
    { match: `^sql db list --resource-group ${RG} --server sql1 `, out: "db1" },
    { match: "^sql db replica list-links .*--server sql1 --name db1 ", out: "sql2\tPrimary" },
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
    firstCall(calls, /^az sql failover-group delete --resource-group rg-lab-az104-06-blob-security --server sql1 --name fog1/),
    firstCall(calls, /^az sql db replica delete-link --resource-group rg-lab-az104-06-blob-security --server sql1 --name db1 --partner-server sql2 --partner-resource-group rg-lab-az104-06-blob-security-nodes --yes/),
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
/** Soft delete already off: for tests about other things (a test about soft delete gives its own rule). */
const SOFT_OFF = { match: "^backup vault backup-properties show", out: "Disabled" };
const ITEM_VM = `/subscriptions/${SUB}/resourceGroups/${R19}/providers/Microsoft.RecoveryServices/vaults/rsv-lab/backupFabrics/Azure/protectionContainers/iaasvmcontainerv2;${R19};vm-app/protectedItems/vm;iaasvmcontainerv2;${R19};vm-app`;

test("unblock turns an unlocked vault's immutability off before soft delete, and warns on a locked one", { skip }, () => {
  const w = world([...VAULT, { match: "^backup vault backup-properties show", out: ["Enabled", "Disabled"] }, { match: "^backup vault show .*immutabilitySettings", out: "Unlocked" },{ match: "^backup item list", out: "" }]);
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
  const l = world([...VAULT, SOFT_OFF, { match: "^backup vault show .*immutabilitySettings", out: "Locked" }, { match: "^backup item list", out: "" }]);
  const lr = l.run("infra/ci/lab-unblock.sh", [L19]);
  assert.equal(lr.status, 0, lr.out);
  assert.equal(firstCall(l.calls(), /^az backup vault update/), -1);
  assert.match(lr.out, /::warning::unblock: rsv-lab: immutability is LOCKED/);
  // Disabled (or a vault that cannot be read): nothing to do.
  const d = world([...VAULT, SOFT_OFF, { match: "^backup vault show", out: "Disabled" }, { match: "^backup item list", out: "" }]);
  assert.equal(d.run("infra/ci/lab-unblock.sh", [L19]).status, 0);
  assert.equal(firstCall(d.calls(), /^az backup vault update/), -1);
  l.cleanup();
  d.cleanup();
});

// Lab 19's vault is made with soft delete on (azurerm refuses a vault made with it off), so unblock turns it off
// before any backup data is deleted. `az backup vault backup-properties show` answers [storage config, vault config];
// the vault config's properties.softDeleteFeatureState is Enabled, Disabled or AlwaysON (az 2.86, azure-cli custom.py).
const SOFT_SHOW = /^az backup vault backup-properties show --name rsv-lab --resource-group rg-lab-az104-19-backup --query \[\]\.properties\.softDeleteFeatureState \| \[0\] -o tsv$/;
const SOFT_SET = /^az backup vault backup-properties set --name rsv-lab --resource-group rg-lab-az104-19-backup --soft-delete-feature-state Disable -o none$/;
const SOFT_ITEMS = { match: "^backup item list .*isScheduledForDeferredDelete", out: `${ITEM_VM}\tAzureIaasVM\tVM` };

test("unblock turns soft delete off and checks it, then undeletes soft-deleted items and deletes their backup data", { skip }, () => {
  const w = world([
    ...VAULT,
    { match: "^backup vault backup-properties show", out: ["Enabled", "Disabled"] },
    SOFT_ITEMS,
    { match: "^backup item list .*\\[\\]\\.\\[id", out: `${ITEM_VM}\tAzureIaasVM\tVM` },
    { match: "^backup item list", out: "" },
  ]);
  const r = w.run("infra/ci/lab-unblock.sh", [L19]);
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  const order = [
    firstCall(calls, SOFT_SHOW),
    firstCall(calls, SOFT_SET),
    lastCall(calls, SOFT_SHOW),
    firstCall(calls, new RegExp(`^az backup protection undelete --ids ${ITEM_VM.replace(/[.;]/g, "\\$&")} --backup-management-type AzureIaasVM --workload-type VM -o none$`)),
    firstCall(calls, /^az backup protection disable --ids .*vm-app --delete-backup-data true --yes --backup-management-type AzureIaasVM --workload-type VM -o none$/),
  ];
  for (const i of order) assert.ok(i >= 0, `missing call; calls were:\n${calls.join("\n")}`);
  assert.deepEqual([...new Set(order)].sort((a, b) => a - b), order, `out of order:\n${calls.join("\n")}`);
  assert.match(r.stdout, /unblock: rsv-lab: soft delete turned off/);
  assert.match(r.stdout, /unblock: rsv-lab: soft-deleted item .*vm-app undeleted/);
  assert.doesNotMatch(r.stderr, /unverified/);
  w.cleanup();

  // Already off: nothing to set (a second run finds nothing to do).
  const off = world([...VAULT, { match: "^backup vault backup-properties show", out: "Disabled" }, { match: "^backup item list", out: "" }]);
  assert.equal(off.run("infra/ci/lab-unblock.sh", [L19]).status, 0);
  assert.equal(firstCall(off.calls(), /backup-properties set/), -1);
  off.cleanup();
});

test("unblock: soft delete always on, or not off after asking, is unverified and the run goes on", { skip }, () => {
  // AlwaysON cannot be turned off by anyone: never asked, said loudly, and protection is still stopped.
  const on = world([...VAULT, { match: "^backup vault backup-properties show", out: "AlwaysON" }, { match: "^backup item list .*\\[\\]\\.\\[id", out: `${ITEM_VM}\tAzureIaasVM\tVM` }, { match: "^backup item list", out: "" }]);
  const r = on.run("infra/ci/lab-unblock.sh", [L19]);
  assert.equal(r.status, 0, r.out);
  assert.equal(firstCall(on.calls(), /backup-properties set/), -1);
  assert.match(r.stderr, /::warning::unblock: rsv-lab: soft delete is ALWAYS ON/);
  assert.match(r.stderr, /::warning::unblock: unverified: .*rsv-lab soft delete/);
  assert.ok(firstCall(on.calls(), /^az backup protection disable --ids .*vm-app/) >= 0);
  assert.match(r.stdout, /unblock: done/);
  on.cleanup();

  // Asked, but still Enabled when read back (or the set failed, or the state cannot be read): unverified.
  for (const [rules, why] of [
    [[{ match: "^backup vault backup-properties show", out: "Enabled" }], "still on"],
    [[{ match: "^backup vault backup-properties show", out: ["Enabled", "Enabled"] }, { match: "^backup vault backup-properties set", code: 1, err: "ERROR: (UserErrorSoftDeleteStateChangeNotAllowed)" }], "set refused"],
    [[{ match: "^backup vault backup-properties show", out: "", code: 1, err: "ERROR: (ServiceUnavailable)" }], "unreadable"],
  ]) {
    const w = world([...VAULT, ...rules,{ match: "^backup item list", out: "" }]);
    const x = w.run("infra/ci/lab-unblock.sh", [L19]);
    assert.equal(x.status, 0, `${why}: ${x.out}`);
    assert.ok(firstCall(w.calls(), SOFT_SET) >= 0, `${why}: soft delete off is still asked for`);
    assert.match(x.stderr, /::warning::unblock: unverified: .*rsv-lab soft delete/, why);
    assert.doesNotMatch(x.stdout, /soft delete turned off/, why);
    w.cleanup();
  }
});

test("unblock stops protection for backup items of every management type", { skip }, () => {
  // `az backup item list` with no --backup-management-type sends no filter, so it lists every type (az 2.86, checked).
  const items = [
    [ITEM_VM, "AzureIaasVM", "VM"],
    [`/subscriptions/${SUB}/resourceGroups/${R19}/providers/Microsoft.RecoveryServices/vaults/rsv-lab/backupFabrics/Azure/protectionContainers/storagecontainer;Storage;${R19};l19k3x9qsa/protectedItems/AzureFileShare;labshare`, "AzureStorage", "AzureFileShare"],
    [`/subscriptions/${SUB}/resourceGroups/${R19}/providers/Microsoft.RecoveryServices/vaults/rsv-lab/backupFabrics/Azure/protectionContainers/vmappcontainer;compute;${R19};vm-sql/protectedItems/sqldatabase;mssqlserver;labdb`, "AzureWorkload", "SQLDataBase"],
    [`/subscriptions/${SUB}/resourceGroups/${R19}/providers/Microsoft.RecoveryServices/vaults/rsv-lab/backupFabrics/Azure/protectionContainers/mab;agent/protectedItems/mab;files`, "MAB", "FileFolder"],
  ];
  const w = world([...VAULT, SOFT_OFF, { match: "^backup item list .*\\[\\]\\.\\[id", out: [items.map((i) => i.join("\t")).join("\n"), ""] }, { match: "^backup item list", out: "" }]);
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
  const gone = world([...VAULT, SOFT_OFF, { match: "^backup item list .*\\[\\]\\.\\[id", out: `${ITEM_VM}\tAzureIaasVM\tVM` }, { match: "^backup item list .*--query \\[\\]\\.id ", out: [ITEM_VM, ITEM_VM, ""] }]);
  const r = gone.run("infra/ci/lab-unblock.sh", [L19]);
  assert.equal(r.status, 0, r.out);
  const sleeps = gone.calls().filter((c) => c.startsWith("sleep "));
  assert.deepEqual(sleeps, ["sleep 15", "sleep 15"]);
  assert.match(r.out, /rsv-lab: no backup items left/);
  // Still there after the wait (default 300 s): a warning, and the run goes on to destroy.
  const stuck = world([...VAULT, SOFT_OFF, { match: "^backup item list .*\\[\\]\\.\\[id", out: `${ITEM_VM}\tAzureIaasVM\tVM` }, { match: "^backup item list .*--query \\[\\]\\.id ", out: ITEM_VM }]);
  const s = stuck.run("infra/ci/lab-unblock.sh", [L19]);
  assert.equal(s.status, 0, s.out);
  const waited = stuck.calls().filter((c) => c.startsWith("sleep ")).reduce((n, c) => n + Number(c.split(" ")[1]), 0);
  assert.ok(waited <= 300 && waited >= 285, `waited ${waited} s`);
  assert.match(s.out, /::warning::unblock: rsv-lab: 1 backup item\(s\) still listed after 300 s/);
  assert.match(s.out, /unblock: done/);
  // The wait is configurable (a release test may want longer), still bounded.
  const short = world([...VAULT, SOFT_OFF, { match: "^backup item list .*\\[\\]\\.\\[id", out: `${ITEM_VM}\tAzureIaasVM\tVM` }, { match: "^backup item list .*--query \\[\\]\\.id ", out: ITEM_VM }]);
  short.run("infra/ci/lab-unblock.sh", [L19], { LAB_UNBLOCK_VAULT_WAIT_SECONDS: "30" });
  assert.deepEqual(short.calls().filter((c) => c.startsWith("sleep ")), ["sleep 15", "sleep 15"]);
  for (const x of [gone, stuck, short]) x.cleanup();
});

test("unblock: a backup item list that fails is unverified, never \"no backup items left\", and the run goes on", { skip }, () => {
  const ITEMS = { match: "^backup item list .*\\[\\]\\.\\[id", out: `${ITEM_VM}\tAzureIaasVM\tVM` };
  // Azure cannot answer the wait's list at all.
  const down = world([...VAULT, SOFT_OFF, ITEMS, { match: "^backup item list .*--query \\[\\]\\.id ", out: "", code: 1, err: "ERROR: (ServiceUnavailable) try again later" }]);
  const r = down.run("infra/ci/lab-unblock.sh", [L19], { LAB_UNBLOCK_VAULT_WAIT_SECONDS: "30" });
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /no backup items left/);
  assert.match(r.stderr, /::warning::unblock: rsv-lab: could not list backup items/);
  assert.match(r.stderr, /::warning::unblock: unverified: rsv-lab backup items/);
  assert.match(r.stdout, /unblock: done/);
  // Still bounded by the wait.
  assert.deepEqual(down.calls().filter((c) => c.startsWith("sleep ")), ["sleep 15", "sleep 15"]);
  // One failed list, then an empty one: that is "no items left", and nothing is unverified.
  const blip = world([...VAULT, SOFT_OFF, ITEMS, { match: "^backup item list .*--query \\[\\]\\.id ", out: ["", ""], code: [1, 0] }]);
  const b = blip.run("infra/ci/lab-unblock.sh", [L19]);
  assert.equal(b.status, 0, b.out);
  assert.match(b.stdout, /rsv-lab: no backup items left/);
  assert.doesNotMatch(b.stderr, /unverified/);
  for (const x of [down, blip]) x.cleanup();
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
  const w = world([POLL(""), { match: "^group list", out: GROUPS }, { match: "^account show", out: SUB }, ...ENTRA]);
  // No terraform state, no terraform at all: the safety net works from Azure's own lists.
  const r = w.run("infra/ci/lab-safety-net.sh", [ID], { TF_STATE_MISSING: "1" });
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  assert.ok(calls.includes(`az group delete --name ${RG} --yes --no-wait`), calls.join("\n"));
  assert.ok(calls.includes(`az group delete --name ${RG}-nodes --yes --no-wait`));
  assert.ok(firstCall(calls, /^az group list --query \[\]\.\[name, properties\.provisioningState\]/) >firstCall(calls, new RegExp(`^az group delete --name ${RG} `)), "then polled until gone");
  assert.ok(calls.includes("az ad user delete --id u-ann"));
  assert.ok(firstCall(calls, /^az rest --method delete --url https:\/\/graph\.microsoft\.com\/v1\.0\/directory\/deletedItems\/u-ann/) > calls.indexOf("az ad user delete --id u-ann"), "then purged from the recycle bin, so the next deploy can reuse the name");
  assert.ok(calls.includes("az ad group delete --group g-readers"));
  assert.equal(calls.filter((c) => c.startsWith("terraform")).length, 0);
  w.cleanup();
});

// The safety net polls `az group list` for each group's provisioningState: Deleting, back (the delete failed), or gone.
const NAMES = (out) => ({ match: /^group list --query \[\]\.name /, out });
const POLL = (out, code) => ({ match: /^group list --query \[\]\.\[name, properties\.provisioningState\]/, out, ...(code ? { code } : {}) });
const sleptFor = (calls) => calls.filter((c) => c.startsWith("sleep ")).reduce((n, c) => n + Number(c.split(" ")[1]), 0);
const deletesOf = (calls, g) => calls.filter((c) => c === `az group delete --name ${g} --yes --no-wait`).length;

test("safety net: a group delete that failed (the group is back) is unblocked again and retried", { skip }, () => {
  const w = world([NAMES(RG), { match: "^account show", out: SUB }, POLL([`${RG}\tDeleting`, `${RG}\tSucceeded`, `${RG}\tDeleting`, ""])]);
  const r = w.run("infra/ci/lab-safety-net.sh", [ID]);
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  assert.equal(deletesOf(calls, RG), 2, calls.join("\n"));
  // Unblock ran (it lists the group's locks) between the first delete and the second.
  const second = lastCall(calls, new RegExp(`^az group delete --name ${RG} `));
  const unblock = firstCall(calls, new RegExp(`^az lock list --resource-group ${RG} `));
  assert.ok(unblock > firstCall(calls, new RegExp(`^az group delete --name ${RG} `)) && unblock < second, calls.join("\n"));
  assert.match(r.out, new RegExp(`retrying the delete of ${RG} \\(1 of 2\\)`));
  assert.match(r.out, new RegExp(`safety net: ${RG} is gone`));
  assert.equal(firstCall(calls, /^az group wait/), -1, "never az group wait, which cannot tell a failed delete from a slow one");
  w.cleanup();
});

test("safety net: a group whose delete keeps failing is retried a bounded number of times, then left behind", { skip }, () => {
  const w = world([NAMES(RG), { match: "^account show", out: SUB }, POLL(`${RG}\tSucceeded`), ...ENTRA]);
  const r = w.run("infra/ci/lab-safety-net.sh", [ID]);
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  assert.equal(deletesOf(calls, RG), 3, "the first delete and two retries");
  assert.match(r.out, new RegExp(`::warning::safety net: ${RG}: the delete failed 3 times .*left behind`));
  // And the sweep goes on to Entra rather than hanging.
  assert.ok(calls.includes("az ad user delete --id u-ann"), calls.join("\n"));
  // LAB_DELETE_RETRIES sets the bound.
  const once = world([NAMES(RG), { match: "^account show", out: SUB }, POLL(`${RG}\tFailed`)]);
  once.run("infra/ci/lab-safety-net.sh", [ID], { LAB_DELETE_RETRIES: "0" });
  assert.equal(deletesOf(once.calls(), RG), 1);
  w.cleanup();
  once.cleanup();
});

test("safety net: a slow delete is waited for only until the job's deadline, then reported as left behind", { skip }, () => {
  const now = Math.floor(Date.now() / 1000);
  // Parse payload's LAB_JOB_DEADLINE: 1000 s left in the job, 420 s of it kept for the rest of the job.
  const w = world([NAMES(RG), { match: "^account show", out: SUB }, POLL(`${RG}\tDeleting`)]);
  const r = w.run("infra/ci/lab-safety-net.sh", [ID], { LAB_JOB_DEADLINE: String(now + 1000) });
  assert.equal(r.status, 0, r.out);
  const slept = sleptFor(w.calls());
  assert.ok(slept <= 580 && slept >= 500, `slept ${slept} s`);
  assert.equal(deletesOf(w.calls(), RG), 1, "Deleting is slow, not failed: no retry");
  assert.match(r.out, new RegExp(`::warning::safety net: ${RG} was not gone within \\d+s.*left behind`));
  // A deadline already past: no waiting at all.
  const late = world([NAMES(RG), { match: "^account show", out: SUB }, POLL(`${RG}\tDeleting`)]);
  const lr = late.run("infra/ci/lab-safety-net.sh", [ID], { LAB_JOB_DEADLINE: String(now - 60) });
  assert.equal(lr.status, 0, lr.out);
  assert.equal(sleptFor(late.calls()), 0);
  assert.match(lr.out, /left behind/);
  // No deadline (a run by hand): LAB_DELETE_WAIT_SECONDS bounds it.
  const hand = world([NAMES(RG), { match: "^account show", out: SUB }, POLL(`${RG}\tDeleting`)]);
  hand.run("infra/ci/lab-safety-net.sh", [ID], { LAB_DELETE_WAIT_SECONDS: "120" });
  assert.ok(sleptFor(hand.calls()) <= 120);
  for (const x of [w, late, hand]) x.cleanup();
});

test("safety net: a group list that fails while polling is not read as gone", { skip }, () => {
  const w = world([NAMES(RG), { match: "^account show", out: SUB }, POLL(["", `${RG}\tDeleting`, ""], [1, 0, 0])]);
  const r = w.run("infra/ci/lab-safety-net.sh", [ID]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.stderr, /could not list resource groups to see how the deletes are going/);
  assert.match(r.stdout, new RegExp(`safety net: ${RG} is gone`));
  // Polled three times: the failed list, Deleting, then gone (a failure read as "gone" would stop at one).
  assert.equal(w.calls().filter((c) => /^az group list --query \[\]\.\[name/.test(c)).length, 3);
  w.cleanup();
});

test("safety net never touches rg-lab-<id>x, another lab or NetworkWatcherRG", { skip }, () => {
  const w = world([POLL(""), { match: "^group list", out: GROUPS }, { match: "^account show", out: SUB }, ...ENTRA]);
  w.run("infra/ci/lab-safety-net.sh", [ID]);
  const deletes = w.calls().filter((c) => / delete /.test(c) || / wait /.test(c));
  for (const c of deletes) assert.ok(!/rg-lab-az104-06-blob-securityx|rg-lab-az104-07-files|NetworkWatcherRG|rg-wg-ondemand|u-x|u-steven|g-other/.test(c), c);
  w.cleanup();
});

test("governance safety net deletes custom roles, policy assignments and definitions, then management groups children first", { skip }, () => {
  const G = "az104-03-mgmt-groups";
  const MG = (n) => `/providers/Microsoft.Management/managementGroups/${n}`;
  const w = world([
    POLL(""), { match: "^group list", out: `rg-lab-${G}` },
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
    POLL(""), { match: "^group list", out: `rg-lab-${L1}` },
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
    // name, type, provisioningState (the state last: see the batch 3 test below).
    { match: `^resource list --resource-group ${RG} `, out: [`vnet-lab\tMicrosoft.Network/virtualNetworks\tUpdating\nl06sa\tMicrosoft.Storage/storageAccounts\tSucceeded`, `vnet-lab\tMicrosoft.Network/virtualNetworks\tUpdating\nl06sa\tMicrosoft.Storage/storageAccounts\tSucceeded`, `vnet-lab\tMicrosoft.Network/virtualNetworks\tSucceeded\nl06sa\tMicrosoft.Storage/storageAccounts\tSucceeded`] },
  ]);
  const r = w.run("infra/ci/lab-ready.sh", [ID, "4"], { LAB_READY_INTERVAL: "0" });
  assert.equal(r.status, 0, r.out);
  assert.equal(w.calls().filter((c) => c.startsWith(`az resource list --resource-group ${RG} `)).length, 3);
  assert.match(r.out, /ready/i);
  w.cleanup();

  const stuck = world([
    { match: "^group list", out: `${RG}\tSucceeded` },
    { match: `^resource list --resource-group ${RG} `, out: `vnet-lab\tMicrosoft.Network/virtualNetworks\tFailed` },
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

// ── Batch 3 teardown (labs batch 3 plan, C0.5; spec §17 rulings 30-31) ───

// Lab 23: a failover group over a Basic primary (uksouth group) and its geo-secondary (secondary group).
const L23 = "az305-23-sql-failover";
const R23 = `rg-lab-${L23}`;
const R23S = `${R23}-secondary`;
/** SQL as unblock finds lab 23; `swapped` after a failover (the ukwest server is primary). */
const sqlWorld = (swapped = false, extra = []) => [
  { match: "^group list", out: `${R23}\n${R23S}\nrg-lab-az104-07-files` },
  { match: `^sql server list --resource-group ${R23} `, out: "l23k3x9q-sqlp" },
  { match: `^sql server list --resource-group ${R23S} `, out: "l23k3x9q-sqls" },
  { match: `^sql failover-group list --resource-group ${R23} --server l23k3x9q-sqlp `, out: `l23k3x9q-fog\t${swapped ? "Secondary" : "Primary"}` },
  { match: `^sql failover-group list --resource-group ${R23S} --server l23k3x9q-sqls `, out: `l23k3x9q-fog\t${swapped ? "Primary" : "Secondary"}` },
  { match: `^sql db list --resource-group ${R23} --server l23k3x9q-sqlp `, out: "appdb" },
  { match: `^sql db list --resource-group ${R23S} --server l23k3x9q-sqls `, out: "appdb\nscratch" },
  { match: `^sql db replica list-links --resource-group ${R23} --server l23k3x9q-sqlp --name appdb `, out: `l23k3x9q-sqls\t${swapped ? "Secondary" : "Primary"}` },
  { match: `^sql db replica list-links --resource-group ${R23S} --server l23k3x9q-sqls --name appdb `, out: `l23k3x9q-sqlp\t${swapped ? "Primary" : "Secondary"}` },
  ...extra,
];

test("unblock deletes SQL failover groups, then geo-replication links", { skip }, () => {
  const w = world(sqlWorld());
  const r = w.run("infra/ci/lab-unblock.sh", [L23]);
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  // The group is deleted once, on the server that holds the primary.
  const fog = calls.filter((c) => c.startsWith("az sql failover-group delete"));
  assert.deepEqual(fog, [`az sql failover-group delete --resource-group ${R23} --server l23k3x9q-sqlp --name l23k3x9q-fog -o none`]);
  // Then the geo-replication link, from the primary database, naming the partner's own group.
  const links = calls.filter((c) => c.startsWith("az sql db replica delete-link"));
  assert.deepEqual(links, [`az sql db replica delete-link --resource-group ${R23} --server l23k3x9q-sqlp --name appdb --partner-server l23k3x9q-sqls --partner-resource-group ${R23S} --yes -o none`]);
  assert.ok(firstCall(calls, /^az sql failover-group delete/) < firstCall(calls, /^az sql db replica delete-link/), calls.join("\n"));
  assert.match(r.out, /l23k3x9q-fog: failover group deleted/);
  assert.match(r.out, /appdb: geo-replication link to l23k3x9q-sqls removed/);
  // Never another lab's servers.
  assert.ok(!calls.some((c) => /rg-lab-az104-07-files/.test(c) && !c.startsWith("az group list")));
  w.cleanup();
  // After a failover the roles are swapped: the ukwest server holds the primary, and Terraform's view is stale.
  const s = world(sqlWorld(true));
  assert.equal(s.run("infra/ci/lab-unblock.sh", [L23]).status, 0);
  assert.deepEqual(s.calls().filter((c) => c.startsWith("az sql failover-group delete")), [`az sql failover-group delete --resource-group ${R23S} --server l23k3x9q-sqls --name l23k3x9q-fog -o none`]);
  assert.deepEqual(s.calls().filter((c) => c.startsWith("az sql db replica delete-link")), [`az sql db replica delete-link --resource-group ${R23S} --server l23k3x9q-sqls --name appdb --partner-server l23k3x9q-sqlp --partner-resource-group ${R23} --yes -o none`]);
  s.cleanup();
  // Azure refusing either is a warning, and the run still ends 0.
  const f = world(sqlWorld(false, []).map((x) => x).concat([{ match: "^sql failover-group delete", code: 1, err: "ERROR: Conflict" }, { match: "^sql db replica delete-link", code: 1, err: "ERROR: Conflict" }]));
  const fr = f.run("infra/ci/lab-unblock.sh", [L23]);
  assert.equal(fr.status, 0, fr.out);
  assert.match(fr.stderr, /::warning::unblock: l23k3x9q-fog: could not delete the failover group/);
  assert.match(fr.stderr, /::warning::unblock: appdb: could not remove the geo-replication link/);
  f.cleanup();
});

// Lab 26: Site Recovery replicating a uksouth VM into the vault in the secondary group.
const L26 = "az305-26-site-recovery";
const R26 = `rg-lab-${L26}`;
const R26S = `${R26}-secondary`;
const RSV = `/subscriptions/${SUB}/resourceGroups/${R26S}/providers/Microsoft.RecoveryServices/vaults/rsv-lab`;
const ASR_ITEM = `${RSV}/replicationFabrics/fabric-uksouth/replicationProtectionContainers/pc-uksouth/replicationProtectedItems/vm-app`;
const NET_MAP = `${RSV}/replicationFabrics/fabric-uksouth/replicationNetworks/azureNetwork/replicationNetworkMappings/map-source-target`;
const CONT_MAP = `${RSV}/replicationFabrics/fabric-uksouth/replicationProtectionContainers/pc-uksouth/replicationProtectionContainerMappings/map-uks-ukw`;
const POLICY = `${RSV}/replicationPolicies/policy-6h`;
/** Site Recovery as unblock finds lab 26; `items` answers the wait's list of replicated items in turn. */
const asrWorld = ({ state = "None", items = [""], itemsCode = 0 } = {}) => [
  { match: "^group list", out: `${R26}\n${R26S}` },
  { match: `^backup vault list --resource-group ${R26S} `, out: "rsv-lab" },
  { match: "^backup vault backup-properties show", out: "Disabled" },
  { match: "^backup item list", out: "" },
  { match: "^rest --method get --url .*/replicationProtectedItems\\?.*value\\[\\]\\.\\[id, properties\\.testFailoverState", out: `${ASR_ITEM}\t${state}` },
  { match: "^rest --method get --url .*/replicationProtectedItems\\?.*--query value\\[\\]\\.\\[id, properties\\.currentScenario", out: items, code: itemsCode },
  { match: "^rest --method get --url .*/replicationNetworkMappings\\?", out: NET_MAP },
  { match: "^rest --method get --url .*/replicationProtectionContainerMappings\\?", out: CONT_MAP },
  { match: "^rest --method get --url .*/replicationPolicies\\?", out: POLICY },
];

test("unblock cleans up a test failover before removing replication", { skip }, () => {
  const w = world(asrWorld({ state: "Completed" }));
  const r = w.run("infra/ci/lab-unblock.sh", [L26]);
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  const cleanup = firstCall(calls, new RegExp(`^az rest --method post --url ${ASR_ITEM}/testFailoverCleanup\\?api-version=2023-08-01 --body \\{"properties":\\{"comments":"[^"]+"\\}\\}`));
  const remove = firstCall(calls, new RegExp(`^az rest --method post --url ${ASR_ITEM}/remove\\?api-version=2023-08-01`));
  assert.ok(cleanup >= 0 && remove > cleanup, calls.join("\n"));
  assert.match(r.out, /vm-app: test failover cleanup started/);
  w.cleanup();
  // No test failover (None, or none at all), or one already being cleaned up: no cleanup call.
  for (const state of ["None", "", "MarkedForDeletion"]) {
    const n = world(asrWorld({ state }));
    assert.equal(n.run("infra/ci/lab-unblock.sh", [L26]).status, 0);
    assert.equal(firstCall(n.calls(), /testFailoverCleanup/), -1, state);
    assert.ok(firstCall(n.calls(), /replicationProtectedItems\/vm-app\/remove/) >= 0, state);
    n.cleanup();
  }
});

test("unblock waits until a vault has no replicated items, then removes network mappings, container mappings and policies, never failing the run", { skip }, () => {
  const w = world(asrWorld({ items: [ASR_ITEM, ASR_ITEM, ""] }));
  const r = w.run("infra/ci/lab-unblock.sh", [L26]);
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  const remove = firstCall(calls, /replicationProtectedItems\/vm-app\/remove/);
  const lastWait = lastCall(calls, /replicationProtectedItems\?.*--query value\[\]\.\[id, properties\.currentScenario/);
  const net = firstCall(calls, new RegExp(`^az rest --method delete --url ${NET_MAP}\\?api-version=2023-08-01`));
  const cont = firstCall(calls, new RegExp(`^az rest --method post --url ${CONT_MAP}/remove\\?api-version=2023-08-01 --body \\{"properties":\\{"providerSpecificInput":\\{\\}\\}\\}`));
  const pol = firstCall(calls, new RegExp(`^az rest --method delete --url ${POLICY}\\?api-version=2023-08-01`));
  assert.ok(remove >= 0 && lastWait > remove && net > lastWait && cont > net && pol > cont, calls.join("\n"));
  assert.deepEqual(calls.filter((c) => c.startsWith("sleep ")), ["sleep 15", "sleep 15"]);
  assert.match(r.out, /rsv-lab: no replicated items left/);
  w.cleanup();
  // Still replicating after the wait (default 900 s, bounded): a warning, and the run goes on.
  const stuck = world(asrWorld({ items: [ASR_ITEM] }));
  const s = stuck.run("infra/ci/lab-unblock.sh", [L26]);
  assert.equal(s.status, 0, s.out);
  const waited = stuck.calls().filter((c) => c.startsWith("sleep ")).reduce((n, c) => n + Number(c.split(" ")[1]), 0);
  assert.ok(waited <= 900 && waited >= 885, `waited ${waited} s`);
  assert.match(s.stderr, /::warning::unblock: rsv-lab: 1 replicated item\(s\) still listed after 900 s/);
  stuck.cleanup();
  // The wait is configurable; a list that fails is never "none left": unverified.
  const down = world(asrWorld({ items: [""], itemsCode: 1 }));
  const d = down.run("infra/ci/lab-unblock.sh", [L26], { LAB_UNBLOCK_ASR_WAIT_SECONDS: "30" });
  assert.equal(d.status, 0, d.out);
  assert.deepEqual(down.calls().filter((c) => c.startsWith("sleep ")), ["sleep 15", "sleep 15"]);
  assert.doesNotMatch(d.out, /no replicated items left/);
  assert.match(d.stderr, /::warning::unblock: unverified: .*rsv-lab replicated items/);
  down.cleanup();
  // Every removal Azure refuses is a warning.
  const refused = world([...asrWorld(), { match: "^rest --method (post|delete) ", code: 1, err: "ERROR: (BadRequest)" }]);
  const x = refused.run("infra/ci/lab-unblock.sh", [L26]);
  assert.equal(x.status, 0, x.out);
  for (const what of ["could not disable replication for vm-app", "could not delete network mapping map-source-target", "could not remove container mapping map-uks-ukw", "could not delete replication policy policy-6h"]) assert.match(x.stderr, new RegExp(`::warning::unblock: rsv-lab: ${what}`));
  refused.cleanup();
});

// testFailoverCleanup is asynchronous (202) and az rest does not wait for it: a remove posted while the cleanup
// still runs is refused. Unblock polls the item until its test failover state is None (or empty, or
// MarkedForDeletion) before posting remove, and the vault wait re-sends remove for an item still listed that is not
// already being removed (bounded), so a refused first remove is not the end of it.
const ITEM_STATE = "^rest --method get --url [^ ]*/replicationProtectedItems/vm-app\\?api-version=2023-08-01 --query properties\\.testFailoverState -o tsv$";
const REMOVE_RE = "^rest --method post --url [^ ]*/replicationProtectedItems/vm-app/remove\\?";
const isRemove = (c) => /^az rest --method post --url [^ ]*\/replicationProtectedItems\/vm-app\/remove\?/.test(c);
const isState = (c) => /^az rest --method get --url [^ ]*\/replicationProtectedItems\/vm-app\?api-version=2023-08-01 --query properties\.testFailoverState /.test(c);
const isWaitList = (c) => /^az rest --method get --url [^ ]*\/replicationProtectedItems\?.*--query value\[\]\.\[id, properties\.currentScenario/.test(c);
const listedAs = (scenario, protection) => `${ASR_ITEM}\t${scenario}\t${protection}`;

test("unblock waits for a test failover cleanup to finish before removing replication", { skip }, () => {
  const w = world([{ match: ITEM_STATE, out: ["Completed", "Completed", "None"] }, ...asrWorld({ state: "Completed" })]);
  const r = w.run("infra/ci/lab-unblock.sh", [L26]);
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  const cleanup = firstCall(calls, /testFailoverCleanup/);
  const polls = calls.map((c, i) => (isState(c) ? i : -1)).filter((i) => i >= 0);
  const remove = calls.findIndex(isRemove);
  assert.equal(polls.length, 3, `polled the item until None:\n${calls.join("\n")}`);
  assert.ok(cleanup >= 0 && polls[0] > cleanup && remove > polls[2], calls.join("\n"));
  assert.match(r.out, /rsv-lab: vm-app: test failover cleanup finished/);
  w.cleanup();
  // Empty or MarkedForDeletion count as finished too.
  for (const state of ["", "MarkedForDeletion"]) {
    const e = world([{ match: ITEM_STATE, out: state }, ...asrWorld({ state: "Completed" })]);
    assert.equal(e.run("infra/ci/lab-unblock.sh", [L26]).status, 0);
    assert.equal(e.calls().filter(isState).length, 1, state);
    e.cleanup();
  }
  // A cleanup that never finishes: bounded (LAB_UNBLOCK_ASR_CLEANUP_WAIT_SECONDS), a warning, and remove is still sent.
  const slow = world([{ match: ITEM_STATE, out: "Completed" }, ...asrWorld({ state: "Completed" })]);
  const s = slow.run("infra/ci/lab-unblock.sh", [L26], { LAB_UNBLOCK_ASR_CLEANUP_WAIT_SECONDS: "45" });
  assert.equal(s.status, 0, s.out);
  assert.equal(slow.calls().filter(isState).length, 4, slow.calls().join("\n"));
  assert.match(s.stderr, /::warning::unblock: rsv-lab: the test failover cleanup of vm-app had not finished after 45 s/);
  assert.ok(slow.calls().some(isRemove));
  slow.cleanup();
  // A cleanup Azure refuses is not waited for.
  const no = world([{ match: "testFailoverCleanup", code: 1, err: "ERROR: (BadRequest)" }, ...asrWorld({ state: "Completed" })]);
  assert.equal(no.run("infra/ci/lab-unblock.sh", [L26]).status, 0);
  assert.equal(no.calls().filter(isState).length, 0);
  no.cleanup();
});

test("unblock re-sends remove for an item still listed after its first remove was refused, then sees the vault empty", { skip }, () => {
  // The cleanup is still pending when unblock stops waiting for it; Azure refuses the first remove, then accepts.
  const pending = listedAs("TestFailoverCleanup", "Protected");
  const w = world([
    { match: ITEM_STATE, out: "Completed" },
    { match: REMOVE_RE, code: [1, 0], err: ["ERROR: (Conflict) a test failover cleanup is in progress", ""] },
    ...asrWorld({ state: "Completed", items: [pending, pending, pending, pending, pending, listedAs("DisableDr", "Protected"), ""] }),
  ]);
  const r = w.run("infra/ci/lab-unblock.sh", [L26], { LAB_UNBLOCK_ASR_CLEANUP_WAIT_SECONDS: "15" });
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  const removes = calls.map((c, i) => (isRemove(c) ? i : -1)).filter((i) => i >= 0);
  assert.equal(removes.length, 2, `remove sent again once:\n${calls.join("\n")}`);
  assert.ok(removes[1] > calls.findIndex(isWaitList), "the second remove comes from the wait");
  assert.match(r.stderr, /::warning::unblock: rsv-lab: could not disable replication for vm-app/);
  assert.match(r.out, /unblock: rsv-lab: replication disabled for vm-app \(sent again\)/);
  assert.match(r.out, /rsv-lab: no replicated items left/);
  w.cleanup();
  // An item never removed: the re-sends are bounded, and the run still ends 0 with a warning.
  const stuck = world([{ match: REMOVE_RE, code: 1, err: "ERROR: (Conflict)" }, ...asrWorld({ items: [listedAs("", "Protected")] })]);
  const st = stuck.run("infra/ci/lab-unblock.sh", [L26]);
  assert.equal(st.status, 0, st.out);
  const n = stuck.calls().filter(isRemove).length;
  assert.ok(n >= 3 && n <= 9, `${n} removes: one, then at most 8 re-sends`);
  assert.match(st.stderr, /::warning::unblock: rsv-lab: 1 replicated item\(s\) still listed after 900 s/);
  stuck.cleanup();
  // An item already being removed (DisableDr, or a disabling protection state) is not sent remove again.
  const busy = world(asrWorld({ items: [listedAs("DisableDr", "Protected"), listedAs("", "DisablingProtection"), ...Array(8).fill(listedAs("DisableDr", "Protected")), ""] }));
  assert.equal(busy.run("infra/ci/lab-unblock.sh", [L26]).status, 0);
  assert.equal(busy.calls().filter(isRemove).length, 1, busy.calls().join("\n"));
  busy.cleanup();
});

// A recovery plan a learner made by hand holds its items: Azure will not disable replication for an item in a
// plan, and a vault with a plan left in it cannot be deleted.
const RECOVERY_PLAN = `${RSV}/replicationRecoveryPlans/rp-learner`;
test("unblock deletes a vault's recovery plans before removing replication, never failing the run", { skip }, () => {
  const plans = { match: "^rest --method get --url .*/replicationRecoveryPlans\\?", out: RECOVERY_PLAN };
  const w = world([...asrWorld(), plans]);
  const r = w.run("infra/ci/lab-unblock.sh", [L26]);
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  const list = firstCall(calls, new RegExp(`^az rest --method get --url /subscriptions/\\{subscriptionId\\}/resourceGroups/${R26S}/providers/Microsoft.RecoveryServices/vaults/rsv-lab/replicationRecoveryPlans\\?api-version=2023-08-01 `));
  const del = firstCall(calls, new RegExp(`^az rest --method delete --url ${RECOVERY_PLAN}\\?api-version=2023-08-01`));
  const remove = firstCall(calls, /replicationProtectedItems\/vm-app\/remove/);
  assert.ok(list >= 0 && del > list && remove > del, calls.join("\n"));
  assert.match(r.out, /unblock: rsv-lab: recovery plan rp-learner deleted/);
  w.cleanup();
  // A vault with no replicated items left still has its plans deleted.
  const empty = world([{ match: "^rest --method get --url .*/replicationProtectedItems\\?", out: "" }, ...asrWorld(), plans]);
  assert.equal(empty.run("infra/ci/lab-unblock.sh", [L26]).status, 0);
  assert.ok(firstCall(empty.calls(), new RegExp(`^az rest --method delete --url ${RECOVERY_PLAN}\\?`)) >= 0, empty.calls().join("\n"));
  empty.cleanup();
  // Azure refuses the delete, or the list: a warning each, and replication is still removed.
  for (const [extra, warning] of [
    [{ match: "^rest --method delete --url .*/replicationRecoveryPlans/", code: 1, err: "ERROR: (BadRequest)" }, /::warning::unblock: rsv-lab: could not delete recovery plan rp-learner/],
    [{ match: "^rest --method get --url .*/replicationRecoveryPlans\\?", code: 1, err: "ERROR: (Forbidden)" }, /::warning::unblock: rsv-lab: could not list recovery plans/],
  ]) {
    const x = world([...asrWorld(), extra, plans]);
    const out = x.run("infra/ci/lab-unblock.sh", [L26]);
    assert.equal(out.status, 0, out.out);
    assert.match(out.stderr, warning);
    assert.ok(firstCall(x.calls(), /replicationProtectedItems\/vm-app\/remove/) >= 0);
    x.cleanup();
  }
});

test("unblock removes an unlocked policy and a legal hold on an HNS account", { skip }, () => {
  // Lab 25's data lake (is_hns_enabled): its file systems are blob containers to the management plane.
  const L25 = "az305-25-storage-design";
  const R25 = `rg-lab-${L25}`;
  const w = world([
    { match: "^group list", out: R25 },
    { match: `^storage account list --resource-group ${R25} `, out: "l25k3x9qlake" },
    { match: "^storage container-rm list .*hasLegalHold", out: "raw" },
    { match: "^storage container legal-hold show .*--container-name raw", out: "case1" },
    { match: "^storage container-rm list .*hasImmutabilityPolicy", out: "curated" },
    { match: "^storage container immutability-policy show .*--container-name curated", out: 'Unlocked\t"0x8DD"' },
  ]);
  const r = w.run("infra/ci/lab-unblock.sh", [L25]);
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  assert.ok(firstCall(calls, new RegExp(`^az storage container legal-hold clear --account-name l25k3x9qlake --container-name raw --resource-group ${R25} --tags case1`)) >= 0, calls.join("\n"));
  assert.ok(firstCall(calls, new RegExp(`^az storage container immutability-policy delete --account-name l25k3x9qlake --container-name curated --resource-group ${R25} --if-match "0x8DD"`)) >= 0, calls.join("\n"));
  w.cleanup();
});

// Lab 22's vault (and lab 21's): Key Vault keeps a deleted vault for its retention (7 days in the labs).
const L22 = "az305-22-keyvault-mi";
const R22 = `rg-lab-${L22}`;
const DELETED_VAULTS = [
  `l22k3x9qkv\tuksouth\t/subscriptions/${SUB}/resourceGroups/${R22}/providers/Microsoft.KeyVault/vaults/l22k3x9qkv`,
  `kv-prod\tuksouth\t/subscriptions/${SUB}/resourceGroups/rg-prod/providers/Microsoft.KeyVault/vaults/kv-prod`,
  `kv-near\tukwest\t/subscriptions/${SUB}/resourceGroups/${R22}x/providers/Microsoft.KeyVault/vaults/kv-near`,
  `kv-two\tukwest\t/subscriptions/${SUB}/resourceGroups/${R22}-secondary/providers/Microsoft.KeyVault/vaults/kv-two`,
].join("\n");

test("the safety net purges soft-deleted Key Vaults that lived in a lab group, and verify counts one as a leftover", { skip }, () => {
  const w = world([
    { match: "^group list --query \\[\\]\\.name ", out: R22 },
    { match: "^group list --query \\[\\]\\.\\[name", out: "" },
    { match: "^account show", out: SUB },
    { match: "^keyvault list-deleted --resource-type vault ", out: DELETED_VAULTS },
  ]);
  const r = w.run("infra/ci/lab-safety-net.sh", [L22], { LAB_DELETE_POLL_SECONDS: "1" });
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  const purges = calls.filter((c) => c.startsWith("az keyvault purge"));
  assert.deepEqual(purges, ["az keyvault purge --name l22k3x9qkv --location uksouth", "az keyvault purge --name kv-two --location ukwest"]);
  // After the group deletes (deleting the group is what soft-deletes the vault).
  assert.ok(firstCall(calls, /^az keyvault purge/) > lastCall(calls, /^az group delete/), calls.join("\n"));
  assert.match(r.out, /purged soft-deleted vault l22k3x9qkv/);
  w.cleanup();
  // Verify: a soft-deleted lab vault is a leftover; another group's never is.
  const out = join(mkdtempSync(join(tmpdir(), "gho-")), "out");
  writeFileSync(out, "");
  const v = world([{ match: "^group list", out: "" }, { match: "^account show", out: SUB }, { match: "^keyvault list-deleted --resource-type vault ", out: DELETED_VAULTS }]);
  const vr = v.run("infra/ci/lab-safety-net.sh", ["--verify", L22], { GITHUB_OUTPUT: fwd(out) });
  assert.equal(vr.status, 1, vr.out);
  const left = JSON.parse(/^leftovers=(.*)$/m.exec(readFileSync(out, "utf8"))[1]);
  assert.deepEqual(left.sort(), ["kv-two (soft-deleted vault)", "l22k3x9qkv (soft-deleted vault)"]);
  assert.equal(v.calls().filter((c) => / purge /.test(c)).length, 0, "verify deletes nothing");
  v.cleanup();
  // A list Azure cannot answer is unverified, never clean.
  const broken = world([{ match: "^group list", out: "" }, { match: "^account show", out: SUB }, { match: "^keyvault list-deleted", code: 1, err: "AuthorizationFailed" }]);
  const b = broken.run("infra/ci/lab-safety-net.sh", ["--verify", L22]);
  assert.equal(b.status, 1);
  assert.match(b.stdout, /unverified: soft-deleted Key Vaults/);
  broken.cleanup();
});

// Lab 20's readme invites a hand-made exemption at its -corp management group. The safety net deletes policy
// exemptions at the lab's management groups and in its resource groups (the groups' resources too) before it
// deletes any of them, and verify counts one as a leftover. Never an exemption anywhere else.
const L20 = "az305-20-landing-zone";
const R20 = `rg-lab-${L20}`;
const MGS = (n) => `/providers/Microsoft.Management/managementGroups/${n}`;
const EX = "/providers/Microsoft.Authorization/policyExemptions";
const exemptionWorld = (extra = []) => [
  POLL(""),
  { match: "^group list --query \\[\\]\\.name ", out: `${R20}\n${R20}x\nNetworkWatcherRG` },
  { match: "^account show", out: SUB },
  { match: "^account management-group list", out: `lab-${L20}-root\tlab-${L20}-root\nlab-${L20}-corp\tlab-${L20}-corp\ncorp\tSteven corp` },
  { match: `^account management-group show --name lab-${L20}-root `, out: "00000000-tenant-root" },
  { match: `^account management-group show --name lab-${L20}-corp `, out: `lab-${L20}-root` },
  // At the -corp group: the learner's own, and one inherited from Steven's parent group (never the lab's).
  { match: `^policy exemption list --scope ${MGS(`lab-${L20}-corp`)} `, out: `${MGS(`lab-${L20}-corp`)}${EX}/learner-ex\n${MGS("corp")}${EX}/steven-ex` },
  // In the lab group: one at the group, one on a resource (Azure's own casing), one inherited from the subscription, and a near-miss group's.
  { match: `^policy exemption list --resource-group ${R20} `, out: [`/subscriptions/${SUB}/resourceGroups/${R20}${EX}/rg-ex`, `/subscriptions/${SUB}/resourcegroups/${R20.toUpperCase()}/providers/Microsoft.KeyVault/vaults/kv1${EX}/kv-ex`, `/subscriptions/${SUB}${EX}/sub-ex`, `/subscriptions/${SUB}/resourceGroups/${R20}x${EX}/near-ex`].join("\n") },
  ...extra,
];

test("the safety net deletes policy exemptions at the lab's management groups and groups before deleting them, and nothing else", { skip }, () => {
  const w = world(exemptionWorld());
  const r = w.run("infra/ci/lab-safety-net.sh", [L20], { LAB_DELETE_POLL_SECONDS: "1" });
  assert.equal(r.status, 0, r.out);
  const calls = w.calls();
  const deletes = calls.filter((c) => c.startsWith("az policy exemption delete"));
  assert.deepEqual(deletes.sort(), [
    `az policy exemption delete --name kv-ex --scope /subscriptions/${SUB}/resourcegroups/${R20.toUpperCase()}/providers/Microsoft.KeyVault/vaults/kv1`,
    `az policy exemption delete --name learner-ex --scope ${MGS(`lab-${L20}-corp`)}`,
    `az policy exemption delete --name rg-ex --scope /subscriptions/${SUB}/resourceGroups/${R20}`,
  ]);
  const lastEx = lastCall(calls, /^az policy exemption delete/);
  assert.ok(lastEx < firstCall(calls, /^az group delete/), calls.join("\n"));
  assert.ok(lastEx < firstCall(calls, /^az account management-group delete/), calls.join("\n"));
  assert.match(r.out, /safety net: deleted policy exemption learner-ex/);
  // Never listed or deleted outside the lab's scopes.
  for (const c of calls.filter((x) => /policy exemption/.test(x))) assert.ok(!/managementGroups\/corp\b|steven-ex|sub-ex|near-ex|rg-lab-az305-20-landing-zonex|NetworkWatcherRG/.test(c), c);
  w.cleanup();
  // A refused delete is a warning; the sweep still ends 0.
  const refused = world(exemptionWorld([{ match: "^policy exemption delete", code: 1, err: "ERROR: (AuthorizationFailed)" }]));
  const x = refused.run("infra/ci/lab-safety-net.sh", [L20], { LAB_DELETE_POLL_SECONDS: "1" });
  assert.equal(x.status, 0, x.out);
  assert.match(x.stderr, /::warning::safety net: could not delete policy exemption learner-ex/);
  refused.cleanup();
});

test("verify clean counts a lab exemption as a leftover, and an exemption list it cannot read as unverified", { skip }, () => {
  const out = join(mkdtempSync(join(tmpdir(), "gho-")), "out");
  writeFileSync(out, "");
  const v = world(exemptionWorld());
  const vr = v.run("infra/ci/lab-safety-net.sh", ["--verify", L20], { GITHUB_OUTPUT: fwd(out) });
  assert.equal(vr.status, 1, vr.out);
  const left = JSON.parse(/^leftovers=(.*)$/m.exec(readFileSync(out, "utf8"))[1]);
  for (const n of ["learner-ex (policy exemption)", "rg-ex (policy exemption)", "kv-ex (policy exemption)"]) assert.ok(left.includes(n), `${n} in ${JSON.stringify(left)}`);
  assert.ok(!left.some((n) => /steven-ex|sub-ex|near-ex/.test(n)), JSON.stringify(left));
  assert.equal(v.calls().filter((c) => / delete /.test(c)).length, 0, "verify deletes nothing");
  v.cleanup();
  // Nothing of the lab left but an exemption list Azure refuses: not clean.
  const b = world([{ match: "^group list", out: "" }, { match: "^account show", out: SUB }, { match: "^account management-group list", out: `lab-${L20}-corp\tlab-${L20}-corp` }, { match: "^policy exemption list", code: 1, err: "ERROR: (InternalServerError)" }]);
  const br = b.run("infra/ci/lab-safety-net.sh", ["--verify", L20]);
  assert.equal(br.status, 1, br.out);
  assert.match(br.stdout, /unverified: policy exemptions at lab-az305-20-landing-zone-corp/);
  b.cleanup();
});

test("a soft-deleted vault's id is matched whatever its case (Azure returns resourcegroups and upper-case groups)", { skip }, () => {
  const MIXED = [
    `kv-lower\tuksouth\t/subscriptions/${SUB}/resourcegroups/${R22}/providers/Microsoft.KeyVault/vaults/kv-lower`,
    `kv-upper\tukwest\t/SUBSCRIPTIONS/${SUB}/RESOURCEGROUPS/${R22.toUpperCase()}-SECONDARY/providers/Microsoft.KeyVault/vaults/kv-upper`,
    `kv-prod\tuksouth\t/subscriptions/${SUB}/resourcegroups/rg-prod/providers/Microsoft.KeyVault/vaults/kv-prod`,
    `kv-near\tuksouth\t/subscriptions/${SUB}/RESOURCEGROUPS/${R22.toUpperCase()}X/providers/Microsoft.KeyVault/vaults/kv-near`,
  ].join("\n");
  const w = world([{ match: "^group list", out: "" }, { match: "^account show", out: SUB }, { match: "^keyvault list-deleted --resource-type vault ", out: MIXED }]);
  const r = w.run("infra/ci/lab-safety-net.sh", [L22], { LAB_DELETE_POLL_SECONDS: "1" });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(w.calls().filter((c) => c.startsWith("az keyvault purge")), ["az keyvault purge --name kv-lower --location uksouth", "az keyvault purge --name kv-upper --location ukwest"]);
  w.cleanup();
});

// Ruling 36: some resource types may never report a provisioningState; one is listed (test-first, on
// release-test evidence) in READY_NO_STATE_TYPES. The list starts empty.
test("ready check accepts an empty state only for types listed as never giving one", { skip }, () => {
  const src = readFileSync(join(REPO, "infra", "ci", "lab-ready.sh"), "utf8").replace(/\r\n/g, "\n");
  assert.match(src, /^READY_NO_STATE_TYPES=\(\)$/m, "the list starts empty");
  const scenario = [
    { match: "^group list", out: `${RG}\tSucceeded` },
    { match: `^resource list --resource-group ${RG} --query \\[\\]\\.\\[name, type, provisioningState\\] `, out: `tm-lab\tMicrosoft.Network/trafficManagerProfiles\t\nl06sa\tMicrosoft.Storage/storageAccounts\tSucceeded` },
  ];
  // As shipped: a resource with no state is never ready.
  const w = world(scenario);
  const r = w.run("infra/ci/lab-ready.sh", [ID, "4"], { LAB_READY_INTERVAL: "0", LAB_READY_SECONDS: "0" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /tm-lab \(no state\)/);
  w.cleanup();
  // With the type listed (a copy of the script), the same resource passes; another type with no state still waits.
  const listed = world([...scenario.slice(0, 1), { ...scenario[1], out: `${scenario[1].out}\nfd-lab\tMicrosoft.Cdn/profiles\t` }]);
  const copy = join(listed.dir, "lab-ready.sh");
  writeFileSync(copy, src.replace(/^READY_NO_STATE_TYPES=\(\)$/m, 'READY_NO_STATE_TYPES=("Microsoft.Network/trafficManagerProfiles")'));
  const run = (args) => spawnSync(BASH, ["--noprofile", "--norc", "-c", 'PATH="$(cygpath -u "$FAKE_BIN" 2>/dev/null || printf %s "$FAKE_BIN"):$PATH"; exec bash --noprofile --norc "$0" "$@"', fwd(copy), ...args], { encoding: "utf8", env: listed.env({ LAB_READY_INTERVAL: "0", LAB_READY_SECONDS: "0" }) });
  const l = run([ID, "4"]);
  const out = (l.stdout ?? "") + (l.stderr ?? "");
  assert.equal(l.status, 1, out);
  assert.doesNotMatch(out, /tm-lab/);
  assert.match(out, /fd-lab \(no state\)/);
  listed.cleanup();
  // Only fd-lab gone: ready.
  const ok = world([...scenario.slice(0, 1), scenario[1]]);
  const copy2 = join(ok.dir, "lab-ready.sh");
  writeFileSync(copy2, src.replace(/^READY_NO_STATE_TYPES=\(\)$/m, 'READY_NO_STATE_TYPES=("Microsoft.Network/trafficManagerProfiles")'));
  const r2 = spawnSync(BASH, ["--noprofile", "--norc", "-c", 'PATH="$(cygpath -u "$FAKE_BIN" 2>/dev/null || printf %s "$FAKE_BIN"):$PATH"; exec bash --noprofile --norc "$0" "$@"', fwd(copy2), ID, "4"], { encoding: "utf8", env: ok.env({ LAB_READY_INTERVAL: "0", LAB_READY_SECONDS: "0" }) });
  assert.equal(r2.status, 0, (r2.stdout ?? "") + (r2.stderr ?? ""));
  ok.cleanup();
});
