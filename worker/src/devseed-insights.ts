// devseed-insights.ts
//
// Plain English: the dev seeder's `insights` story (plan X0.4): the running
// story underneath, plus what the Azure collector and a version-7 agent
// would have stored by now. Every feed ok, a dip in the VM's CPU credits,
// one change to the NSG made by a person in the portal, one active Azure
// issue in the region, a reboot Azure has scheduled, and the VM's vitals.
// Only this story fills the az_* tables and the vitals columns, so every
// other story's pictures stay exactly as before.
//
// Fixed values only (no random numbers): seeding twice gives the same rows.
// Fake identities only: example.net people, all-zero GUIDs, TEST-NET addresses.

import type { Env } from "./env";
import { getSnapshot, saveSnapshot, type VmVitals } from "./state";
import { bucket } from "./history";
import { azureRegionName } from "./region";
import { FEEDS } from "../../shared/azureMetrics";
import type { AzureHealth } from "../../shared/api";
import type { CapacityDoc, MetricDefsDoc } from "./insights/types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const SLOT = 300;
const iso = (ms: number) => new Date(ms).toISOString();

/** wg-admin's own service principal in the seeded rows (a fake GUID, never the real client id). */
export const SEED_WGADMIN_CALLER = "00000000-0000-0000-0000-00000000a11c";
const SUB = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-wg-ondemand/providers";

/** Fill the insights tables and the agent's vitals for a VM that came up at `startMs`. */
export async function seedInsights(env: Env, now: number, startMs: number, region: string): Promise<void> {
  const place = azureRegionName(region);
  const stmts: D1PreparedStatement[] = [];
  const add = (sql: string, ...args: unknown[]) => stmts.push(env.DB.prepare(sql).bind(...args));

  // Every feed worked a couple of minutes ago.
  for (const f of FEEDS) {
    const ok = f.id === "bootLog" ? now - 3 * HOUR : now - 2 * MIN;
    add("INSERT INTO az_feed (feed, last_try_at, last_ok_at, status, error, next_due_at) VALUES (?1, ?2, ?2, 'ok', NULL, ?3)", f.id, iso(ok), f.cadenceMin === null ? null : iso(ok + f.cadenceMin * MIN));
  }

  // Azure's metrics, one 5-minute slot at a time since the VM came up. The credits dip about an hour ago.
  const first = Date.parse(bucket(startMs, SLOT));
  const last = Date.parse(bucket(now - SLOT * 1000, SLOT));
  let i = 0;
  for (let t = first; t <= last; t += SLOT * 1000, i++) {
    const minsAgo = (now - t) / MIN;
    const busy = minsAgo > 55 && minsAgo < 95;
    const cpu = busy ? 38 + (i % 4) * 6 : 4 + (i % 5) * 1.5;
    const credits = busy ? Math.max(18, 140 - (95 - minsAgo) * 3) : minsAgo >= 95 ? 144 : Math.min(70, 18 + (55 - minsAgo) * 1.2);
    add(
      "INSERT INTO hist_az_vm (res, t, cpu_avg, cpu_max, mem_free_min, net_in, net_out, disk_read, disk_write, disk_rops, disk_wops, credits_min, credits_used, avail_avg, os_iops_max, os_bw_max) VALUES (CAST(?1 AS INTEGER), ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
      SLOT, bucket(t, SLOT), cpu, Math.min(100, cpu * 1.8), 412_000_000 - (i % 6) * 3_000_000, 21_000 + (i % 7) * 2_500, 18_000 + (i % 5) * 2_000, 1_200 + (i % 3) * 400, 9_000 + (i % 4) * 1_500, 0.4 + (i % 3) * 0.2, 2.1 + (i % 4) * 0.5, Math.round(credits * 10) / 10, busy ? 4.2 : 0.3, 1, 6 + (i % 5), 3 + (i % 4),
    );
    add(
      "INSERT INTO hist_az_pip (res, t, ddos_max, pkts_in_ddos, pkts_drop_ddos, bytes_in_ddos, bytes_drop_ddos, packets, bytes, syn, vip_avail) VALUES (CAST(?1 AS INTEGER), ?2, 0, ?3, 0, ?4, 0, ?5, ?6, ?7, 100)",
      SLOT, bucket(t, SLOT), 40 + (i % 6) * 5, 21_000 + (i % 7) * 2_500, 12_000 + (i % 7) * 900, 6_300_000 + (i % 7) * 750_000, 30 + (i % 4) * 6,
    );
  }

  // What Azure says about the VM now.
  const health: Omit<AzureHealth, "annotations"> = {
    state: "Available",
    title: "Available",
    summary: "There aren't any known Azure platform problems affecting this virtual machine.",
    reason: null,
    since: iso(startMs + 4 * MIN),
    power: "VM running",
    provisioning: "Provisioning succeeded",
    vmAgent: { status: "Ready", version: "2.11.1.12" },
    bootDiagnostics: true,
    checkedAt: iso(now - 2 * MIN),
  };
  const defs: MetricDefsDoc = { vm: ["Percentage CPU", "Available Memory Bytes", "Network In Total", "Network Out Total", "Disk Read Bytes", "Disk Write Bytes", "Disk Read Operations/Sec", "Disk Write Operations/Sec", "CPU Credits Remaining", "CPU Credits Consumed", "VmAvailabilityMetric", "OS Disk IOPS Consumed Percentage", "OS Disk Bandwidth Consumed Percentage"], pip: ["IfUnderDDoSAttack", "PacketsInDDoS", "PacketsDroppedDDoS", "BytesInDDoS", "BytesDroppedDDoS", "PacketCount", "ByteCount", "SynCount", "VipAvailability"] };
  add("INSERT INTO az_latest (key, json, updated_at) VALUES ('health', ?1, ?2)", JSON.stringify(health), iso(now - 2 * MIN));
  add("INSERT INTO az_latest (key, json, updated_at) VALUES ('metricDefs', ?1, ?2)", JSON.stringify(defs), iso(startMs + 10 * MIN));

  // The Activity Log: wg-admin's own deploy, one change in the portal by a person, and an Azure annotation.
  const act = (id: string, at: number, op: string, status: string, caller: string, kind: string, type: string, name: string, category: string, level = "Informational") =>
    add("INSERT INTO az_activity (id, at, correlation_id, operation, status, caller, caller_kind, resource_type, resource_name, category, level) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)", id, iso(at), `corr-${id}`, op, status, caller, kind, type, name, category, level);
  act("00000000-seed-0000-0000-000000000001", startMs + 1 * MIN, "Microsoft.Network/publicIPAddresses/write", "Succeeded", SEED_WGADMIN_CALLER, "wgadmin", "Public IP", "pip-wg", "Administrative");
  act("00000000-seed-0000-0000-000000000002", startMs + 2 * MIN, "Microsoft.Network/networkSecurityGroups/write", "Succeeded", SEED_WGADMIN_CALLER, "wgadmin", "Network security group", "nsg-wg", "Administrative");
  act("00000000-seed-0000-0000-000000000003", startMs + 3 * MIN, "Microsoft.Compute/virtualMachines/write", "Succeeded", SEED_WGADMIN_CALLER, "wgadmin", "Virtual machine", "vm-wg", "Administrative");
  act("00000000-seed-0000-0000-000000000004", now - 40 * MIN, "Microsoft.Network/networkSecurityGroups/securityRules/write", "Succeeded", "someone@example.net", "person", "Network security group", "nsg-wg", "Administrative");
  act("00000000-seed-0000-0000-000000000005", now - 3 * DAY, "Microsoft.Resourcehealth/healthevent/Activated/action", "Active", "Microsoft.ResourceHealth", "azure", "Virtual machine", "vm-wg", "ResourceHealth", "Warning");

  // Service Health: an active issue in this region now, and last week's finished maintenance.
  add(
    "INSERT INTO az_service_events (tracking_id, type, status, level, title, summary, services, regions, starts_at, ends_at, updated_at) VALUES ('SEED-ISSUE-1', 'ServiceIssue', 'Active', 'Warning', ?1, ?2, ?3, ?4, ?5, NULL, ?6)",
    `Intermittent connectivity for Virtual Machines in ${place}`, "Some customers may see brief packet loss to virtual machines. Engineers are investigating.", JSON.stringify(["Virtual Machines", "Virtual Network"]), JSON.stringify([place]), iso(now - 50 * MIN), iso(now - 12 * MIN),
  );
  add(
    "INSERT INTO az_service_events (tracking_id, type, status, level, title, summary, services, regions, starts_at, ends_at, updated_at) VALUES ('SEED-MAINT-1', 'PlannedMaintenance', 'Resolved', 'Informational', ?1, ?2, ?3, ?4, ?5, ?6, ?6)",
    `Planned network maintenance in ${place}`, "Routine maintenance on network infrastructure.", JSON.stringify(["Network Infrastructure"]), JSON.stringify([place]), iso(now - 10 * DAY), iso(now - 10 * DAY + 4 * HOUR),
  );

  // Capacity: the configured size is offered; one size is not offered to this subscription.
  const capacity: CapacityDoc = {
    sizes: [
      { name: "Standard_B1s", available: true, reason: null, vcpus: 1, family: "standardBSFamily" },
      { name: "Standard_B1ls", available: true, reason: null, vcpus: 1, family: "standardBSFamily" },
      { name: "Standard_B1ms", available: true, reason: null, vcpus: 1, family: "standardBSFamily" },
      { name: "Standard_B2s", available: true, reason: null, vcpus: 2, family: "standardBSFamily" },
      { name: "Standard_B2ats_v2", available: false, reason: "NotAvailableForSubscription", vcpus: 2, family: "standardBasv2Family" },
    ],
    usages: [
      { family: "standardBSFamily", used: 2, limit: 10 },
      { family: "standardBasv2Family", used: 0, limit: 10 },
    ],
    cores: { used: 2, limit: 10 },
  };
  add("INSERT INTO az_capacity (region, json, fetched_at) VALUES (?1, ?2, ?3)", region, JSON.stringify(capacity), iso(now - 2 * HOUR));

  // Retail prices (GBP list prices, before discounts and VAT).
  const price = (item: string, gbp: number, unit: string, meter: string) => add("INSERT INTO az_prices (region, item, gbp, unit, meter, fetched_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)", region, item, gbp, unit, meter, iso(now - 5 * HOUR));
  price("Standard_B1s", 0.0093, "1 Hour", "B1s");
  price("Standard_B1ls", 0.0047, "1 Hour", "B1ls");
  price("disk:E4", 1.97, "1/Month", "E4 LRS Disk");
  price("disk:S4", 1.22, "1/Month", "S4 LRS Disk");
  price("ip:v4", 0.0037, "1 Hour", "Standard IPv4 Static Public IP");

  // The VM's own vitals in its heartbeat history.
  add(
    "UPDATE hist_vm SET mem_used_pct = 38 + (CAST(substr(t, 15, 2) AS INTEGER) % 7), disk_used_pct = 23.5, steal_pct = (CAST(substr(t, 15, 2) AS INTEGER) % 3) * 0.4, conntrack_pct = 0.2 + (CAST(substr(t, 15, 2) AS INTEGER) % 5) * 0.05, net_rtt_ms = 9 + (CAST(substr(t, 15, 2) AS INTEGER) % 4), net_loss_pct = 0 WHERE t >= ?1",
    bucket(startMs, 60),
  );
  await env.DB.batch(stmts);

  // A version-7 agent: vitals on the last heartbeat, and a reboot Azure has scheduled.
  const snap = await getSnapshot(env);
  if (!snap.agent) return;
  const vitals: VmVitals = {
    mem: { total: 948_000_000, available: 571_000_000 },
    disk: { total: 31_000_000_000, used: 7_300_000_000, avail: 23_700_000_000 },
    cpu: { steal_pct: 0.4, iowait_pct: 0.2, ncpu: 1 },
    conntrack: { count: 61, max: 32768 },
    updates: { pending: 3, security: 0, at: iso(now - 2 * HOUR) },
    events: {
      incarnation: 2,
      at: iso(now - 40 * 1000),
      items: [{ id: "00000000-seed-0000-0000-0000000e0001", type: "Reboot", status: "Scheduled", not_before: iso(now + 3 * HOUR), source: "Platform", duration_s: 300, description: "Host server maintenance.", self: true }],
    },
    net: { at: iso(now - 3 * MIN), method: "icmp", targets: [{ ip: "1.1.1.1", rtt_ms: 9.4, loss_pct: 0 }, { ip: "8.8.8.8", rtt_ms: 10.1, loss_pct: 0 }] },
  };
  await saveSnapshot(env, { ...snap, agent: { ...snap.agent, agent_version: 7, vitals } });
}
