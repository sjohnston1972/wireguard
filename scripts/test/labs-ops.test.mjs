// labs-ops.test.mjs
//
// Plain English: the monitor and backup labs (batch 2 plan, area B3: labs 18
// and 19) checked without touching Azure. Each runs the shared content suite
// (fixtures/labs/content.mjs: catalogue rules, lint, one resource group,
// sizes, disks, prices, marker, fmt), then its own tests: what it builds, and
// above all that tear-down can get it back to £0 (a workspace deleted for
// good, a vault with soft delete and immutability off, protection stopped
// with the data deleted). init and validate are npm run labs-tf's job.

import { test } from "node:test";
import assert from "node:assert/strict";
import { attr, lab, labContentSuite, resources, uncomment } from "./fixtures/labs/content.mjs";

const MONITOR = "az104-18-monitor";
const BACKUP = "az104-19-backup";

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

// ── Lab 18: Azure Monitor ────────────────────────────────────────────────

labContentSuite(MONITOR, { marker: "£" });

test(`${MONITOR}: a PerGB2018 workspace with a daily cap of at most 0.05 GB and 30 days' retention`, () => {
  const l = lab(MONITOR);
  const ws = one(l, "azurerm_log_analytics_workspace").body;
  assert.equal(attr(ws, "sku"), '"PerGB2018"');
  const cap = Number(attr(ws, "daily_quota_gb"));
  assert.ok(cap > 0 && cap <= 0.05, `daily_quota_gb ${attr(ws, "daily_quota_gb")} is a cap above 0 and at most 0.05 GB`);
  assert.equal(attr(ws, "retention_in_days"), "30", "30 days: the free retention, and the least PerGB2018 takes");
  // Log Analytics is priced (authored: its meter is per GB, a unit the feed cannot read).
  const item = l.yaml.cost.items.find((i) => /Log Analytics/i.test(i.name));
  assert.ok(item, "a Log Analytics cost item");
  assert.equal(item.retail, undefined, "Log Analytics stays authored (batch 2 ruling 2)");
});

test(`${MONITOR}: the VM sends perf counters every 60 s and syslog warnings and above through AMA and one DCR`, () => {
  const l = lab(MONITOR);
  const vm = one(l, "azurerm_linux_virtual_machine");
  const vmAddr = `azurerm_linux_virtual_machine.${vm.labels[1]}`;
  // AMA authenticates with the VM's system-assigned identity; no role assignment is needed.
  assert.equal(attr(nested(vm.body, "identity"), "type"), '"SystemAssigned"', "the VM has a system-assigned identity");
  assert.equal(attr(vm.body, "identity_ids"), undefined, "no user-assigned identity");

  const ext = one(l, "azurerm_virtual_machine_extension").body;
  assert.equal(attr(ext, "publisher"), '"Microsoft.Azure.Monitor"');
  assert.equal(attr(ext, "type"), '"AzureMonitorLinuxAgent"');
  assert.equal(attr(ext, "virtual_machine_id"), `${vmAddr}.id`);
  assert.equal(attr(ext, "automatic_upgrade_enabled"), "true", "the agent upgrades itself");

  const dcrBlock = one(l, "azurerm_monitor_data_collection_rule");
  const dcr = dcrBlock.body;
  assert.equal(attr(dcr, "kind"), '"Linux"');
  const ws = one(l, "azurerm_log_analytics_workspace");
  const la = nested(nested(dcr, "destinations"), "log_analytics");
  assert.equal(attr(la, "workspace_resource_id"), `azurerm_log_analytics_workspace.${ws.labels[1]}.id`, "the DCR sends to the lab's workspace");
  const perf = nested(nested(dcr, "data_sources"), "performance_counter");
  assert.equal(attr(perf, "sampling_frequency_in_seconds"), "60");
  const counters = strings(attr(perf, "counter_specifiers"));
  assert.ok(counters.length >= 1 && counters.length <= 3, `a few counters only, to keep ingestion tiny (${counters.length})`);
  assert.ok(counters.some((c) => /Processor/.test(c)), "CPU is one of them");
  assert.deepEqual(strings(attr(perf, "streams")), ["Microsoft-Perf"]);
  const syslog = nested(nested(dcr, "data_sources"), "syslog");
  assert.deepEqual(strings(attr(syslog, "log_levels")).sort(), ["Alert", "Critical", "Emergency", "Error", "Warning"]);
  assert.deepEqual(strings(attr(syslog, "streams")), ["Microsoft-Syslog"]);
  const flows = allNested(dcr, "data_flow");
  assert.deepEqual(flows.flatMap((f) => strings(attr(f, "streams"))).sort(), ["Microsoft-Perf", "Microsoft-Syslog"]);
  assert.deepEqual([...new Set(flows.flatMap((f) => strings(attr(f, "destinations"))))], [attr(la, "name").replace(/"/g, "")], "every flow goes to the workspace destination");

  const assoc = one(l, "azurerm_monitor_data_collection_rule_association").body;
  assert.equal(attr(assoc, "target_resource_id"), `${vmAddr}.id`);
  assert.equal(attr(assoc, "data_collection_rule_id"), `azurerm_monitor_data_collection_rule.${dcrBlock.labels[1]}.id`);
});

test(`${MONITOR}: a CPU metric alert and a VM-restart activity log alert, both scoped inside the lab, to an action group with no receivers`, () => {
  const l = lab(MONITOR);
  const vm = one(l, "azurerm_linux_virtual_machine");
  const agBlock = one(l, "azurerm_monitor_action_group");
  const ag = `azurerm_monitor_action_group.${agBlock.labels[1]}.id`;
  // No receivers: nothing is ever emailed, texted, called or posted.
  assert.doesNotMatch(agBlock.body, /_receiver\b/, "the action group has no receivers");
  assert.ok((attr(agBlock.body, "short_name") ?? "").replace(/"/g, "").length <= 12, "short_name is at most 12 characters");

  const metric = one(l, "azurerm_monitor_metric_alert").body;
  assert.equal(attr(metric, "scopes"), `[azurerm_linux_virtual_machine.${vm.labels[1]}.id]`, "the metric alert watches the lab's VM");
  const criteria = nested(metric, "criteria");
  assert.equal(attr(criteria, "metric_namespace"), '"Microsoft.Compute/virtualMachines"');
  assert.equal(attr(criteria, "metric_name"), '"Percentage CPU"');
  assert.equal(attr(nested(metric, "action"), "action_group_id"), ag);

  const activity = one(l, "azurerm_monitor_activity_log_alert").body;
  assert.equal(attr(activity, "scopes"), "[azurerm_resource_group.lab.id]", "the activity log alert watches the lab's group, never the subscription");
  const ac = nested(activity, "criteria");
  assert.equal(attr(ac, "category"), '"Administrative"');
  assert.equal(attr(ac, "operation_name"), '"Microsoft.Compute/virtualMachines/restart/action"');
  assert.equal(attr(nested(activity, "action"), "action_group_id"), ag);
});

test(`${MONITOR}: no diagnostic settings and nothing at subscription scope (batch 2 ruling 9)`, () => {
  const l = lab(MONITOR);
  assert.deepEqual(resources(l).filter((r) => /diagnostic_setting|subscription/.test(r.labels[0])).map((r) => r.labels.join(".")), []);
  assert.deepEqual(l.blocks.filter((b) => b.kind === "data").map((b) => b.labels.join(".")), [], "no data sources (none reads the subscription)");
  assert.doesNotMatch(uncomment(Object.values(l.files).join("\n")), /\/subscriptions\//, "no literal subscription ids");
});

test(`${MONITOR}: versions.tf deletes the workspace permanently on destroy`, () => {
  const l = lab(MONITOR);
  const law = nested(features(l), "log_analytics_workspace");
  assert.ok(law !== undefined, "features has a log_analytics_workspace block");
  // A soft-deleted workspace would be recovered by the next deploy, with its old data and settings.
  assert.equal(attr(law, "permanently_delete_on_destroy"), "true");
});

test(`${MONITOR}: the readme's things to try include KQL on Perf and Syslog`, () => {
  const tries = lab(MONITOR).readme.split("## Things to try")[1].split("## Learn more")[0];
  assert.match(tries, /`Perf \|[^`]*`/, "a Perf query");
  assert.match(tries, /`Syslog \|[^`]*`/, "a Syslog query");
  assert.match(tries, /action group/i, "adding a receiver by hand is suggested");
});

// ── Lab 19: Backup ───────────────────────────────────────────────────────

labContentSuite(BACKUP, { marker: "£" });

test(`${BACKUP}: a Standard Recovery Services vault, LRS, soft delete off, immutability Disabled`, () => {
  const v = one(lab(BACKUP), "azurerm_recovery_services_vault").body;
  assert.equal(attr(v, "sku"), '"Standard"');
  assert.equal(attr(v, "storage_mode_type"), '"LocallyRedundant"');
  assert.equal(attr(v, "cross_region_restore_enabled"), "false");
  // Soft delete on would keep deleted backup data (and the vault) for 14 days after tear-down.
  assert.equal(attr(v, "soft_delete_enabled"), "false");
  assert.equal(attr(v, "immutability"), '"Disabled"');
});

test(`${BACKUP}: a daily Enhanced (V2) policy keeping 7 days, instant restore 1 day in rg-lab-<id>-irp`, () => {
  const l = lab(BACKUP);
  const vault = one(l, "azurerm_recovery_services_vault");
  const p = one(l, "azurerm_backup_policy_vm").body;
  assert.equal(attr(p, "recovery_vault_name"), `azurerm_recovery_services_vault.${vault.labels[1]}.name`);
  // V2 (Enhanced) backs up Trusted Launch VMs as well as standard ones; V1 refuses Trusted Launch.
  assert.equal(attr(p, "policy_type"), '"V2"');
  assert.equal(attr(nested(p, "backup"), "frequency"), '"Daily"');
  assert.equal(attr(nested(p, "retention_daily"), "count"), "7");
  assert.equal(nested(p, "retention_weekly"), undefined, "daily points only");
  assert.equal(attr(p, "instant_restore_retention_days"), "1");
  // Azure makes the restore-point group itself (appending 1): it must be rg-lab-<id>-*, or the sweep misses it.
  assert.equal(attr(nested(p, "instant_restore_resource_group"), "prefix"), '"${var.resource_group_name}-irp"');
});

test(`${BACKUP}: the VM is protected and versions.tf stops protection and deletes data on destroy`, () => {
  const l = lab(BACKUP);
  const vm = one(l, "azurerm_linux_virtual_machine");
  const vault = one(l, "azurerm_recovery_services_vault");
  const policy = one(l, "azurerm_backup_policy_vm");
  const pv = one(l, "azurerm_backup_protected_vm").body;
  assert.equal(attr(pv, "source_vm_id"), `azurerm_linux_virtual_machine.${vm.labels[1]}.id`);
  assert.equal(attr(pv, "backup_policy_id"), `azurerm_backup_policy_vm.${policy.labels[1]}.id`);
  assert.equal(attr(pv, "recovery_vault_name"), `azurerm_recovery_services_vault.${vault.labels[1]}.name`);
  const rs = nested(features(l), "recovery_service");
  assert.ok(rs !== undefined, "features has a recovery_service block");
  assert.equal(attr(rs, "vm_backup_stop_protection_and_retain_data_on_destroy"), "false", "destroy deletes the backup data");
  // azurerm takes only one of the two retain settings; suspend is left at its default (false).
  assert.equal(attr(rs, "vm_backup_suspend_protection_and_retain_data_on_destroy"), undefined, "destroy never just suspends");
  assert.equal(attr(rs, "purge_protected_items_from_vault_on_destroy"), "true", "items made by hand (Backup now on another VM) are purged with the vault");
  // Priced: one protected instance, from the price feed.
  const item = l.yaml.cost.items.find((i) => i.retail?.meter === "Azure VM Protected Instance");
  assert.ok(item, "an Azure VM Protected Instance cost item");
  assert.equal(item.retail.unit, "1/Month");
  assert.equal(item.qty ?? 1, 1);
});

test(`${BACKUP}: a staging storage account for restores, named from name_prefix and inside the lab`, () => {
  const sa = one(lab(BACKUP), "azurerm_storage_account").body;
  assert.match(attr(sa, "name"), /^"\$\{var\.name_prefix\}[a-z0-9]+"$/);
  assert.equal(attr(sa, "account_tier"), '"Standard"');
  assert.equal(attr(sa, "account_replication_type"), '"LRS"', "restores need a non-zonal account in the vault's region");
  assert.equal(attr(sa, "allow_nested_items_to_be_public"), "false");
});

test(`${BACKUP}: destroy allows for the vault to clear its backup items`, () => {
  const { timing } = lab(BACKUP).yaml;
  // Unblock waits up to 5 minutes for the vault to list no items, then Terraform deletes the rest.
  assert.ok(timing.destroy_min >= 10, `destroy_min ${timing.destroy_min} is at least 10`);
  assert.ok(Math.min(150, 2 * (timing.deploy_min + timing.destroy_min) + 20) >= 50, "the job timeout leaves room for a slow vault");
});

test(`${BACKUP}: the readme says to restore only into rg-lab-<id> and never to lock immutability or make soft delete always-on`, () => {
  const r = lab(BACKUP).readme;
  assert.match(r, /[Rr]estore[^\n]*only into `rg-lab-az104-19-backup`/);
  assert.match(r, /[Nn]ever lock[^\n]*immutability/);
  assert.match(r, /[Nn]ever[^\n]*soft delete[^\n]*[Aa]lways[- ]on/);
  assert.match(r, /Backup now/);
});
