// shared/azureMetrics.ts
//
// Plain English: the Azure insights catalogue, read by both the Worker (the
// collector asks Azure for exactly these metrics and stores each one in its
// column) and the app (a widget shows `title` large and Azure's own `name`
// in small print). Also the feeds' plain titles and cadences, the change
// log's resource kinds and the Service Health services watched. Spec:
// docs/superpowers/specs/2026-10-04-azure-insights-design.md, sections 3, 4 and 6.
//
// Pure data and pure functions: no React, no Worker code.

import type { FeedId } from "./api";

export type MetricAggregation = "Average" | "Maximum" | "Minimum" | "Total";

/** hist_az_vm's value columns, in table order (migration 0019). */
export const VM_COLUMNS = ["cpu_avg", "cpu_max", "mem_free_min", "net_in", "net_out", "disk_read", "disk_write", "disk_rops", "disk_wops", "credits_min", "credits_used", "avail_avg", "os_iops_max", "os_bw_max"] as const;
export type VmColumn = (typeof VM_COLUMNS)[number];

/** hist_az_pip's value columns, in table order. */
export const PIP_COLUMNS = ["ddos_max", "pkts_in_ddos", "pkts_drop_ddos", "bytes_in_ddos", "bytes_drop_ddos", "packets", "bytes", "syn", "vip_avail"] as const;
export type PipColumn = (typeof PIP_COLUMNS)[number];

/** The VM's own vitals in hist_vm (from the heartbeat), in table order. */
export const VITALS_COLUMNS = ["mem_used_pct", "disk_used_pct", "steal_pct", "conntrack_pct", "net_rtt_ms", "net_loss_pct"] as const;
export type VitalsColumn = (typeof VITALS_COLUMNS)[number];

export interface AzureMetric {
  resource: "vm" | "pip";
  /** Azure's metric name, exactly as the metrics API takes it ("Percentage CPU"). */
  name: string;
  aggregation: MetricAggregation;
  /** Where it is stored (hist_az_vm or hist_az_pip). */
  column: VmColumn | PipColumn;
  /** What a widget calls it, large. */
  title: string;
  /** The stored value's unit: "%", "bytes", "bytes/s", "ops/s", "credits", "packets", "packets/s", "bytes in slot", "0 or 1". */
  unit: string;
}

const vm = (name: string, aggregation: MetricAggregation, column: VmColumn, title: string, unit: string): AzureMetric => ({ resource: "vm", name, aggregation, column, title, unit });
const pip = (name: string, aggregation: MetricAggregation, column: PipColumn, title: string, unit: string): AzureMetric => ({ resource: "pip", name, aggregation, column, title, unit });

/**
 * Every metric the collector asks for, one entry per stored column. Byte
 * totals are stored as per-second rates over the 5-minute slot.
 * (V) items (spec 4, 15) are confirmed live; a name Azure does not emit for
 * this resource is left out of the call through the metricDefs feed.
 */
export const AZURE_METRICS: readonly AzureMetric[] = [
  vm("Percentage CPU", "Average", "cpu_avg", "CPU used", "%"),
  vm("Percentage CPU", "Maximum", "cpu_max", "CPU used (peak)", "%"),
  vm("Available Memory Bytes", "Minimum", "mem_free_min", "Memory free", "bytes"),
  vm("Network In Total", "Total", "net_in", "Data in", "bytes/s"),
  vm("Network Out Total", "Total", "net_out", "Data out", "bytes/s"),
  vm("Disk Read Bytes", "Total", "disk_read", "Disk read", "bytes/s"),
  vm("Disk Write Bytes", "Total", "disk_write", "Disk written", "bytes/s"),
  vm("Disk Read Operations/Sec", "Average", "disk_rops", "Disk reads per second", "ops/s"),
  vm("Disk Write Operations/Sec", "Average", "disk_wops", "Disk writes per second", "ops/s"),
  vm("CPU Credits Remaining", "Minimum", "credits_min", "Credits left", "credits"),
  vm("CPU Credits Consumed", "Total", "credits_used", "Credits used", "credits"),
  vm("VmAvailabilityMetric", "Average", "avail_avg", "Azure availability", "0 to 1"),
  vm("OS Disk IOPS Consumed Percentage", "Maximum", "os_iops_max", "Disk IOPS used", "%"),
  vm("OS Disk Bandwidth Consumed Percentage", "Maximum", "os_bw_max", "Disk bandwidth used", "%"),
  pip("IfUnderDDoSAttack", "Maximum", "ddos_max", "Under DDoS attack", "0 or 1"),
  pip("PacketsInDDoS", "Maximum", "pkts_in_ddos", "Inbound packets", "packets/s"),
  pip("PacketsDroppedDDoS", "Maximum", "pkts_drop_ddos", "Dropped packets", "packets/s"),
  pip("BytesInDDoS", "Maximum", "bytes_in_ddos", "Inbound bytes", "bytes/s"),
  pip("BytesDroppedDDoS", "Maximum", "bytes_drop_ddos", "Dropped bytes", "bytes/s"),
  pip("PacketCount", "Total", "packets", "Packets", "packets"),
  pip("ByteCount", "Total", "bytes", "Bytes", "bytes in slot"),
  pip("SynCount", "Total", "syn", "SYN packets", "packets"),
  pip("VipAvailability", "Average", "vip_avail", "Data path availability", "%"),
];

/** The metric stored in `column`, or undefined. */
export function metricByColumn(column: string): AzureMetric | undefined {
  return AZURE_METRICS.find((m) => m.column === column);
}

/** The distinct Azure metric names for a resource, in catalogue order (what a metrics call's `metricnames` lists, before metricDefs trims it). */
export function azureMetricNames(resource: "vm" | "pip"): string[] {
  return [...new Set(AZURE_METRICS.filter((m) => m.resource === resource).map((m) => m.name))];
}

// ── Feeds ──────────────────────────────────────────────────────────────────

export interface FeedInfo {
  id: FeedId;
  /** Plain English, for feed ages and the diagnostics page. */
  title: string;
  /** Minutes between runs while it applies; null = on demand (boot log). A widget shows its data as stale after 3 cadences. */
  cadenceMin: number | null;
}

/** Every feed in the runner's priority order (spec section 4). `housekeeping` runs too but is not a FeedId: nothing shows it. */
export const FEEDS: readonly FeedInfo[] = [
  { id: "health", title: "Azure health", cadenceMin: 5 },
  { id: "vmMetrics", title: "VM metrics", cadenceMin: 5 },
  { id: "pipMetrics", title: "Public IP metrics", cadenceMin: 5 },
  { id: "metricDefs", title: "Metric names", cadenceMin: 1440 },
  { id: "activity", title: "Activity log", cadenceMin: 5 },
  { id: "serviceHealth", title: "Service health", cadenceMin: 15 },
  { id: "capacity", title: "Capacity and quota", cadenceMin: 1440 },
  { id: "prices", title: "Retail prices", cadenceMin: 1440 },
  { id: "bootLog", title: "Boot log", cadenceMin: null },
];


/** How many cadences old a feed's last success may be before its widget shows the age in amber. */
export const STALE_CADENCES = 3;

/**
 * True when a feed's last success is older than 3 cadences at `now` (ms).
 * Never for an on-demand feed, or one that has not worked yet: that is
 * "Waiting", not stale.
 */
export function feedIsStale(feed: { lastOkAt: string | null; cadenceMin: number | null }, now: number): boolean {
  if (!feed.lastOkAt || feed.cadenceMin === null) return false;
  const at = Date.parse(feed.lastOkAt);
  return Number.isFinite(at) && now - at > STALE_CADENCES * feed.cadenceMin * 60_000;
}

// ── The change log's resource kinds (activity.azureChanges Types) ─────────

export interface AzureResourceKind {
  /** The widget setting's value. */
  value: "vm" | "nsg" | "pip" | "nic" | "disk" | "vnet" | "rg" | "other";
  /** The plain name stored in az_activity.resource_type and sent as AzureChangeRow.resourceType. */
  label: string;
  /** The ARM resource type it comes from (lower case compare); null for the resource group itself and Other. */
  armType: string | null;
}

export const AZURE_RESOURCE_KINDS: readonly AzureResourceKind[] = [
  { value: "vm", label: "Virtual machine", armType: "microsoft.compute/virtualmachines" },
  { value: "nsg", label: "Network security group", armType: "microsoft.network/networksecuritygroups" },
  { value: "pip", label: "Public IP", armType: "microsoft.network/publicipaddresses" },
  { value: "nic", label: "Network interface", armType: "microsoft.network/networkinterfaces" },
  { value: "disk", label: "Disk", armType: "microsoft.compute/disks" },
  { value: "vnet", label: "Virtual network", armType: "microsoft.network/virtualnetworks" },
  { value: "rg", label: "Resource group", armType: null },
  { value: "other", label: "Other", armType: null },
];

/** The Service Health services that count as "VMs or networking" (spec section 4; (V) the names). */
export const SERVICE_HEALTH_SERVICES: readonly string[] = ["Virtual Machines", "Virtual Network", "Network Infrastructure", "Load Balancer", "Azure DNS"];
