// shared/widgets.ts
//
// Plain English: the one list of dashboard widgets, read by both the app
// (to draw each widget's settings cog and apply the choices) and the Worker
// (to check every save). Each widget says what can be set (Data,
// Thresholds, Display), the choices and ranges, and today's value as the
// default; each page says how its widgets sit in rows. Spec:
// docs/superpowers/specs/2026-10-03-widgets-design.md, sections 4-6 and 8.
//
// Pure data and pure functions: no React, no Worker code. Option lists that
// mirror Worker constants (change kinds, capture interfaces, event types)
// are copied here so the app never imports the Worker; a Worker test proves
// the copies match.
//
// Two readers of saved preferences:
//   - normalisePagePrefs: lenient, on every read. Repairs what an older or
//     newer dashboard saved by dropping what it cannot use, one value at a
//     time, and answers the sparse form (only what differs from defaults).
//   - validatePagePrefs: strict, on every save. Refuses anything the lenient
//     reader would have to repair, naming the field.

import type { PagePrefs, SettingValue } from "./api";
import { AZURE_RESOURCE_KINDS } from "./azureMetrics";

export type { PagePrefs, SettingValue };

export type PageId = "overview" | "clients" | "firewall" | "activity" | "cost";
export const PAGE_IDS: readonly PageId[] = ["overview", "clients", "firewall", "activity", "cost"];
export const PAGE_TITLES: Record<PageId, string> = { overview: "Overview", clients: "Clients", firewall: "Firewall", activity: "Activity", cost: "Cost" };

export type Section = "data" | "thresholds" | "display";
/** The cog's sections, in the order they are shown. */
export const SECTIONS: readonly Section[] = ["data", "thresholds", "display"];
export const SECTION_TITLES: Record<Section, string> = { data: "Data", thresholds: "Thresholds", display: "Display" };

export interface Option {
  value: string;
  label: string;
}

/** A threshold pair. null = off. */
export interface Threshold {
  warn: number | null;
  bad: number | null;
}

export type SettingSpec =
  | { kind: "enum"; key: string; label: string; section: Section; options: Option[]; default: string }
  | { kind: "boolean"; key: string; label: string; section: Section; default: boolean }
  | { kind: "number"; key: string; label: string; section: Section; min: number; max: number; step: number; unit?: string; default: number }
  /** A set of choices; a saved value always lists them in the options' order. */
  | { kind: "multi"; key: string; label: string; section: Section; options: Option[]; minSelected: number; default: string[] }
  /**
   * Dashboard colouring only (never alerts). above: amber at or over warn, red at or over bad.
   * below: amber under warn, red under bad. When both are on, warn comes first in that direction.
   */
  | { kind: "threshold"; key: string; label: string; section: "thresholds"; unit: string; min: number; max: number; step: number; direction: "above" | "below"; default: Threshold };

export interface WidgetDef {
  /** "page.camelCase", stable, never reused. */
  id: string;
  page: PageId;
  /** The cog is named "<title> settings". */
  title: string;
  /** One line for the Add widgets library: what the widget shows. No full stop. */
  description: string;
  /** A lucide-react icon name ("Gauge") for the library. */
  icon?: string;
  /**
   * Off until the person turns it on (layout.shown); the insights widgets.
   * Visible = defaultOff ? shown.includes(id) : !hidden.includes(id).
   */
  defaultOff?: true;
  /** The widget its home row's Replace modal preselects when that row is full. */
  replaces?: string;
  /** Starts at 1. Bump it (and add `migrate`) when a setting changes meaning or is renamed. */
  version: number;
  /** Pinned widgets cannot be hidden (they carry a page's primary actions). */
  pinned?: boolean;
  settings: SettingSpec[];
  /** Turn settings saved by an older version into this version's, or null to drop them. */
  migrate?: (fromVersion: number, s: Record<string, unknown>) => Record<string, unknown> | null;
}

/**
 * A row's direct item: one widget, or a vertical stack that moves as one
 * unit. A stack's `widgets` are widget ids, or the id of a row nested in
 * the stack (that row's `in` names the stack): Firewall's zones and
 * simulator sit side by side under the rules.
 */
export type LayoutItem = { widget: string; weight: number } | { stack: string; weight: number; widgets: string[]; /** The most members visible at once; default: how many it declares. */ max?: number };
export interface LayoutRow {
  id: string;
  items: LayoutItem[];
  /** Set on a row nested inside a stack: that stack's id. */
  in?: string;
  /**
   * The most items visible at once (a stack counts as one while any member
   * shows). Default: how many it declares. A row or stack that gained
   * default-off widgets keeps its count from before, so it is full as
   * shipped and turning one on means replacing another (spec 9.3).
   */
  max?: number;
}
export interface PageLayout {
  page: PageId;
  rows: LayoutRow[];
}

/** The widgets and layouts the readers check against. Tests may pass their own. */
export interface Registry {
  widgets: readonly WidgetDef[];
  layouts: Partial<Record<PageId, PageLayout>>;
}

/** A refused save: the field at fault (a path such as widgets.overview.keyMetrics.range) and why. */
export interface PrefsProblem {
  field: string;
  message: string;
  /** Saved by an older dashboard (a widget's v is behind): the Worker answers 409 outdated. */
  outdated?: true;
}

/** A save's request body may be at most this long (checked on the raw text, before parsing). */
export const MAX_PREFS_BODY_BYTES = 16 * 1024;
/** A page's stored (normalised) preferences may be at most this long as JSON. */
export const MAX_PAGE_PREFS_BYTES = 8 * 1024;
/**
 * The preferences schema this dashboard saves (PrefsPutBody.schema). 2 added
 * layout.shown; a save without it comes from an older bundle that would drop
 * `shown`, so the Worker answers 409 outdated.
 */
export const PREFS_SCHEMA = 2;

// ── Option lists copied from the Worker (a Worker test keeps them equal) ──

/** Activity event types (worker/src/activity.ts EventType). */
export const EVENT_TYPES: Option[] = [
  { value: "deploy", label: "Deploy" },
  { value: "destroy", label: "Tear down" },
  { value: "failure", label: "Failure" },
  { value: "config", label: "Config" },
  { value: "firewall", label: "Firewall" },
  { value: "watchman", label: "Watchman" },
];

/** The change log's kinds (worker/src/activity.ts AUDIT_KINDS); "all" stands for AUDIT_KINDS' "". */
export const AUDIT_KIND_OPTIONS: Option[] = [
  { value: "all", label: "All changes" },
  { value: "client", label: "Clients" },
  { value: "firewall", label: "Firewall and published ports" },
  { value: "settings", label: "Settings" },
  { value: "profile", label: "Profiles" },
  { value: "schedule", label: "Schedules" },
  { value: "push", label: "Phone alerts" },
  { value: "capture", label: "Packet captures" },
  { value: "lock", label: "Run lock" },
  { value: "config", label: "Backup and restore" },
];

/** Packet capture interfaces (worker/src/firewall.ts CAPTURE_IFACES), labelled by name as the form shows them. */
export const CAPTURE_IFACE_OPTIONS: Option[] = [
  { value: "wg0", label: "wg0" },
  { value: "eth0", label: "eth0" },
  { value: "any", label: "any" },
];

// ── Builders, so the catalogue reads like the spec's table ────────────────

const o = (...vals: (string | [string, string])[]): Option[] => vals.map((v) => (typeof v === "string" ? { value: v, label: v } : { value: v[0], label: v[1] }));
const bool = (section: Section, key: string, label: string, def: boolean): SettingSpec => ({ kind: "boolean", key, label, section, default: def });
const pick = (section: Section, key: string, label: string, options: Option[], def: string): SettingSpec => ({ kind: "enum", key, label, section, options, default: def });
const num = (section: Section, key: string, label: string, min: number, max: number, step: number, def: number, unit?: string): SettingSpec => ({ kind: "number", key, label, section, min, max, step, default: def, ...(unit ? { unit } : {}) });
/** A multi-select; the default is every option unless given. */
const multi = (section: Section, key: string, label: string, options: Option[], minSelected: number, def?: string[]): SettingSpec => ({ kind: "multi", key, label, section, options, minSelected, default: def ?? options.map((x) => x.value) });
const thr = (key: string, label: string, direction: "above" | "below", unit: string, min: number, max: number, step: number, warn: number | null, bad: number | null): SettingSpec => ({ kind: "threshold", key, label, section: "thresholds", unit, min, max, step, direction, default: { warn, bad } });
type DefExtra = Partial<Pick<WidgetDef, "pinned" | "version" | "migrate" | "defaultOff" | "icon" | "replaces">>;
/** A widget; its description comes from DESCRIPTIONS below. */
const def = (id: string, title: string, settings: SettingSpec[], extra: DefExtra = {}): Omit<WidgetDef, "description"> => ({ id, page: id.split(".")[0] as PageId, title, version: 1, settings, ...extra });

const DENSITY = o(["comfortable", "Comfortable"], ["compact", "Compact"]);
const ZONES = o(["clients", "Clients"], ["home", "Home"], ["azure", "Azure"], ["workloads", "Workloads"], ["internet", "Internet"]);

/** The change log's Azure resource kinds (shared/azureMetrics.ts AZURE_RESOURCE_KINDS). */
const AZ_KINDS: Option[] = AZURE_RESOURCE_KINDS.map((k) => ({ value: k.value, label: k.label }));
const ADDED = { defaultOff: true } as const;

// ── The catalogue (spec section 8). Every default is today's behaviour. ──
// The insights widgets (2026-10-04 spec 10.1) close each page's list: all
// default-off, so with nothing saved every page is exactly as before.

const CATALOGUE: readonly Omit<WidgetDef, "description">[] = [
  // Overview
  def("overview.status", "Status banner", [bool("display", "progress", "Step progress bar", true), bool("display", "timing", "Timing block", true), bool("display", "autoDestroy", "Auto-destroy time", true)], { pinned: true }),
  def("overview.topology", "Live topology", [bool("display", "secondLines", "Second lines: addresses, region", true), bool("display", "edgeLabels", "Edge labels: UDP port", true)]),
  def("overview.keyMetrics", "Key metrics", [
    pick("data", "range", "Starting range", o(["live", "Live"], "1h", "24h", "7d", "30d"), "live"),
    multi("data", "tiles", "Tiles", o(["endpoint", "Public endpoint"], ["clients", "Connected clients"], ["latency", "Latency"], ["dns", "DNS status"], ["heartbeat", "Heartbeat"], ["sessionCost", "Session cost"], ["availability", "Availability"]), 1),
    bool("display", "charts", "Sparkline, progress and ring", true),
    bool("display", "subLines", "Sub-lines", true),
    thr("availability", "Availability", "below", "%", 0, 100, 0.1, 99, 90),
    thr("dnsUp", "DNS up", "below", "%", 0, 100, 0.1, 100, null),
    thr("latency", "Latency (average)", "above", "ms", 1, 1000, 1, null, null),
  ]),
  def("overview.run", "Last run", [
    pick("data", "stepFilter", "Starting step filter", o(["all", "All"], ["running", "In progress"], ["done", "Completed"], ["pending", "Pending"]), "all"),
    pick("data", "logLevel", "Starting log level", o(["all", "All"], ["warn", "Warnings and errors"], ["error", "Errors only"]), "all"),
    bool("display", "logTimestamps", "Log timestamps", true),
  ]),
  def("overview.traffic", "Network traffic", [
    pick("data", "window", "Starting window", o("5m", "15m", "1h", ["session", "Session"], "24h", "7d"), "session"),
    pick("data", "units", "Units", o(["kBps", "KB/s"], ["mbps", "Mbit/s"]), "kBps"),
    multi("data", "series", "Series", o(["in", "In"], ["out", "Out"]), 1),
    bool("display", "peak", "Peak line (24h and 7d)", false),
  ]),
  def("overview.events", "Recent events", [
    num("data", "rows", "Rows", 3, 10, 1, 5),
    pick("data", "range", "Range", o("1h", "6h", "24h", "7d"), "24h"),
    multi("data", "types", "Types", EVENT_TYPES, 1),
    bool("display", "detail", "Detail line", true),
  ]),
  def("overview.speedTest", "Speed test", [num("data", "shown", "Results shown", 1, 5, 1, 3), bool("display", "jitter", "Jitter", false), bool("display", "server", "Test server", false)]),
  def("overview.health", "Health summary", [
    multi("data", "checks", "Checks", o(["vm", "VM reachable"], ["wireguard", "WireGuard service"], ["dns", "DNS resolving"], ["tunnel", "Tunnel connectivity"], ["selftest", "Self-test"]), 1),
    bool("display", "ages", "Check ages", true),
    // Added by the insights project: the head's title and sub-line from the verdict (spec 10.3). On gives today's head when there is no new data.
    bool("display", "verdict", "Verdict line", true),
  ]),
  def("overview.costImpact", "Cost impact", [num("data", "sessions", "Sessions in chart", 4, 30, 1, 16), bool("display", "typical", "Typical session line", true), thr("session", "Session estimate", "above", "£", 0, 500, 0.01, null, null)]),
  def("overview.notes", "Watchman notes", [pick("data", "max", "Show at most", o(["all", "All"], "3", "5", "10"), "all"), bool("display", "times", "Times", true)]),
  def(
    "overview.vmPerformance",
    "VM performance",
    [
      pick("data", "range", "Range", o("1h", "24h", "7d", "30d"), "24h"),
      multi("data", "charts", "Charts", o(["cpu", "CPU"], ["credits", "CPU credits"], ["memory", "Memory"], ["network", "Network"], ["disk", "Disk"], ["diskQuota", "Disk quota used"]), 1, ["cpu", "credits", "network"]),
      bool("display", "azureNames", "Azure metric names", true),
      bool("display", "peaks", "Peaks", false),
      thr("cpu", "CPU", "above", "%", 0, 100, 1, 80, 95),
      thr("credits", "Credits left", "below", "credits", 0, 2000, 1, 30, 10),
      thr("memory", "Memory used", "above", "%", 0, 100, 1, 85, 95),
      thr("diskIops", "Disk IOPS used", "above", "%", 0, 100, 1, 80, 95),
    ],
    { ...ADDED, icon: "Gauge", replaces: "overview.traffic" },
  ),
  def(
    "overview.azureHealth",
    "Azure health",
    [
      num("data", "annotations", "Annotations shown", 0, 5, 1, 3),
      bool("data", "maintenance", "Maintenance", true),
      bool("data", "serviceIssues", "Service issues", true),
      bool("display", "feedAges", "Feed ages", true),
      bool("display", "azureTerms", "Azure terms", true),
    ],
    { ...ADDED, icon: "HeartPulse", replaces: "overview.notes" },
  ),
  def(
    "overview.vitals",
    "System vitals",
    [
      multi("data", "rows", "Rows", o(["memory", "Memory"], ["disk", "Disk"], ["load", "Load"], ["steal", "CPU steal"], ["conntrack", "Connections"], ["uptime", "Uptime"], ["updates", "Updates"], ["internet", "Internet"]), 1),
      bool("display", "bars", "Bars", true),
      thr("memory", "Memory used", "above", "%", 0, 100, 1, 85, 95),
      thr("disk", "Disk used", "above", "%", 0, 100, 1, 80, 90),
      thr("load", "Load per vCPU", "above", "per vCPU", 0, 16, 0.1, 1, 2),
      thr("steal", "CPU steal", "above", "%", 0, 100, 1, 10, 25),
      thr("conntrack", "Connections (conntrack)", "above", "%", 0, 100, 1, 70, 90),
      thr("latency", "Internet latency", "above", "ms", 1, 1000, 1, 100, 250),
      thr("loss", "Internet loss", "above", "%", 0, 100, 1, 2, 10),
      thr("securityUpdates", "Security updates", "above", "updates", 0, 500, 1, 1, null),
    ],
    { ...ADDED, icon: "Activity", replaces: "overview.costImpact" },
  ),

  // Clients
  def("clients.kpis", "Client figures", [
    multi("data", "tiles", "Tiles", o(["total", "Total clients"], ["online", "Online now"], ["latency", "Average latency"], ["fullTunnel", "Full-tunnel clients"], ["stale", "Stale handshakes"], ["expiring", "Expiring soon"]), 1),
    bool("display", "subLines", "Sub-lines", true),
    bool("display", "onlineRing", "Online ring", true),
    thr("latency", "Average latency", "above", "ms", 1, 1000, 1, null, null),
  ]),
  def(
    "clients.table",
    "Clients",
    [
      pick("data", "filter", "Starting filter", o(["all", "All"], ["online", "Online"], ["offline", "Offline"], ["expiring", "Expiring"], ["home", "Home site"], ["fullTunnel", "Full tunnel"]), "all"),
      pick("data", "sort", "Starting sort", o(["nameAsc", "Name A→Z"], ["nameDesc", "Name Z→A"], ["address", "Address"], ["handshake", "Last handshake, newest"], ["latency", "Latency, lowest"], ["traffic", "Session traffic, most"], ["expires", "Expires, soonest"]), "nameAsc"),
      multi("data", "columns", "Columns", o(["address", "Address"], ["handshake", "Last handshake"], ["latency", "Latency"], ["traffic", "Session traffic"], ["allowedIps", "Allowed IPs"], ["expires", "Expires"], ["ipv6", "IPv6 address"], ["created", "Created"], ["note", "Note"]), 0, ["address", "handshake", "latency", "traffic", "allowedIps", "expires"]),
      bool("display", "sparkline", "Latency sparkline", true),
      pick("display", "density", "Density", DENSITY, "comfortable"),
      thr("latency", "Latency cell", "above", "ms", 1, 1000, 1, null, null),
    ],
    { pinned: true },
  ),
  def("clients.talkers", "Top talkers", [num("data", "rows", "Rows", 3, 10, 1, 5), pick("data", "measure", "Measure", o(["total", "Total"], ["sent", "Sent by client"], ["received", "Received by client"]), "total")]),
  def("clients.statusDonut", "Client status", [multi("display", "extras", "Extra legend lines", o(["expiring", "Expiring within 7 days"], ["fullTunnel", "Full-tunnel clients"]), 0), bool("display", "percentages", "Percentages in legend", true)]),
  def("clients.sessionTraffic", "Traffic this session", [
    pick("data", "range", "Range", o(["session", "Session"], "1h", "24h", "7d", "30d"), "session"),
    pick("data", "units", "Units", o(["auto", "bytes/s (auto)"], ["mbps", "Mbit/s"]), "auto"),
    multi("data", "series", "Series", o(["in", "Inbound"], ["out", "Outbound"]), 1),
  ]),

  // Firewall
  def("firewall.kpis", "Firewall figures", [
    multi("data", "tiles", "Tiles", o(["policy", "Policy set"], ["default", "Default action"], ["drops", "Recent drops"], ["ports", "Published ports"], ["capture", "Packet capture"]), 1),
    bool("display", "sparkline", "Drops sparkline", true),
    bool("display", "deltas", "Change vs previous 24h", true),
    bool("display", "subLines", "Sub-lines", true),
    thr("drops", "Recent drops (24h)", "above", "drops", 1, 100000, 1, null, null),
  ]),
  def(
    "firewall.rules",
    "Firewall rules",
    [
      pick("data", "tab", "Starting tab", o(["all", "All rules"], ["custom", "Custom"], ["default", "Default"], ["disabled", "Disabled"]), "all"),
      multi("data", "columns", "Columns", o(["service", "Service / Port"], ["hits", "Hits (24h)"], ["lastHit", "Last hit"], ["lifetime", "Lifetime hits"]), 0, ["service", "hits"]),
      bool("display", "sparkline", "Hits sparkline", true),
      pick("display", "density", "Density", DENSITY, "comfortable"),
    ],
    { pinned: true },
  ),
  def("firewall.zones", "Network zones", [bool("display", "addresses", "Zone addresses", true), bool("display", "ruleCounts", "Rule counts", true), bool("display", "arrows", "Flow arrows", true)]),
  def("firewall.simulator", "Test specific traffic", [
    pick("data", "from", "Starting From zone", ZONES, "clients"),
    pick("data", "to", "Starting To zone", ZONES, "home"),
    pick("data", "proto", "Starting protocol", o(["tcp", "TCP"], ["udp", "UDP"], ["icmp", "ICMP"]), "tcp"),
    num("data", "port", "Starting port", 1, 65535, 1, 22),
  ]),
  def("firewall.drops", "Recent drops", [
    pick("data", "max", "Show at most", o(["all", "All"], "10", "25", "50"), "all"),
    pick("display", "timeZone", "Times in", o(["uk", "UK time"], ["utc", "UTC"]), "uk"),
    bool("display", "zoneChip", "Zone chip", true),
    bool("display", "allowButton", "Allow button", true),
  ]),
  def("firewall.ports", "Published ports", [bool("display", "showOff", "Turned-off ports", true), bool("display", "connections", "Connections and last hit", false)]),
  def("firewall.capture", "Packet capture", [
    pick("data", "iface", "Starting interface", CAPTURE_IFACE_OPTIONS, "wg0"),
    num("data", "seconds", "Starting seconds", 5, 300, 5, 30, "s"),
    num("data", "recent", "Recent captures shown", 1, 10, 1, 5),
  ]),
  def(
    "firewall.publicIp",
    "Public IP and DDoS",
    [
      pick("data", "range", "Range", o("1h", "24h", "7d"), "24h"),
      multi("data", "series", "Series", o(["packets", "Packets"], ["bytes", "Bytes"], ["syn", "SYN packets"], ["dropped", "Dropped by DDoS mitigation"]), 1, ["packets", "dropped"]),
      bool("display", "azureNames", "Azure metric names", true),
      thr("availability", "Data path availability", "below", "%", 0, 100, 0.1, 99.9, 99),
      thr("dropped", "Dropped packets per 5 minutes", "above", "packets", 1, 1e9, 1, null, null),
    ],
    { ...ADDED, icon: "ShieldAlert", replaces: "firewall.capture" },
  ),

  // Activity
  def("activity.kpis", "Activity figures", [
    multi("data", "tiles", "Tiles", o(["deploys", "Deploys"], ["duration", "Median deploy duration"], ["success", "Success rate"], ["failed", "Failed runs"], ["config", "Config changes"], ["watchman", "Watchman problems"]), 1),
    bool("display", "deltas", "Change vs previous period", true),
    bool("display", "subLines", "Sub-lines", true),
    thr("successRate", "Success rate", "below", "%", 0, 100, 0.1, 90, 70),
    thr("failedRuns", "Failed runs", "above", "runs", 1, 1000, 1, null, 1),
    thr("watchman", "Watchman problems", "above", "problems", 1, 1000, 1, 1, null),
  ]),
  def("activity.timeline", "Activity timeline", [multi("data", "series", "Series", EVENT_TYPES, 1), bool("display", "legend", "Legend", true)]),
  def(
    "activity.list",
    "Runs and activity",
    [
      pick("data", "tab", "Starting tab", o(["runs", "Runs"], ["all", "All activity"], ["changes", "Config changes"], ["notes", "Watchman notes"]), "runs"),
      multi("data", "runColumns", "Runs columns", o(["duration", "Duration"], ["cost", "Cost impact"], ["actor", "Actor"], ["source", "Source"], ["notes", "Notes"], ["publicIp", "Public IP"]), 0, ["duration", "cost", "actor", "source", "notes"]),
      pick("display", "density", "Density", DENSITY, "comfortable"),
    ],
    { pinned: true },
  ),
  def("activity.stream", "Live event stream", [
    pick("data", "type", "Starting event type", [{ value: "all", label: "All events" }, ...EVENT_TYPES], "all"),
    bool("display", "autoScroll", "Auto-scroll at start", true),
    bool("display", "detail", "Detail line", true),
    pick("display", "timeFormat", "Time format", o(["clock", "HH:MM:SS"], ["relative", "Relative"]), "clock"),
  ]),
  def("activity.changeLog", "Change log", [
    pick("data", "kind", "Starting change kind", AUDIT_KIND_OPTIONS, "all"),
    bool("display", "whatChanged", "What changed column", true),
    bool("display", "by", "By column", true),
    // Added by the insights project: Azure's change log rows, tagged "Azure", among wg-admin's own (off: today's list).
    bool("data", "azure", "Include Azure changes", false),
  ]),
  def("activity.runDetails", "Run details", [
    pick("data", "run", "Run shown on Activity", o(["newest", "Newest run"], ["newestFailed", "Newest failed run"]), "newest"),
    bool("display", "durations", "Step durations", true),
    pick("display", "nameLines", "Step name lines", o("1", "2"), "2"),
  ]),
  def("activity.liveOutput", "Live output", [num("data", "lines", "Lines", 20, 200, 20, 60), bool("display", "wrap", "Wrap long lines", false), bool("display", "timestamps", "Timestamps", true), bool("display", "levelTags", "Level tags", true)]),
  def(
    "activity.azureChanges",
    "Azure change log",
    [
      pick("data", "range", "Range", o("24h", "7d", "30d", "90d"), "7d"),
      pick("data", "who", "Who", o(["all", "Everyone"], ["others", "Everyone but wg-admin"], ["wgadmin", "wg-admin only"]), "all"),
      multi("data", "types", "Types", AZ_KINDS, 1),
      bool("display", "status", "Status column", true),
      bool("display", "caller", "Caller column", true),
      bool("display", "failedOnly", "Failed only", false),
    ],
    { ...ADDED, icon: "History", replaces: "activity.changeLog" },
  ),
  def(
    "activity.serviceHealth",
    "Azure service health",
    [
      pick("data", "range", "Range", o("7d", "30d", "90d"), "30d"),
      multi("data", "types", "Types", o(["issue", "Service issues"], ["maintenance", "Planned maintenance"]), 1),
      bool("display", "summaries", "Summaries", true),
    ],
    { ...ADDED, icon: "CloudAlert", replaces: "activity.liveOutput" },
  ),

  // Cost
  def("cost.kpis", "Cost figures", [
    multi("data", "tiles", "Tiles", o(["session", "This session"], ["month", "Month to date"], ["estimate", "Estimated this month"], ["budget", "Monthly budget"], ["guard", "Cost guard"]), 1),
    bool("display", "deltas", "Change vs previous", true),
    bool("display", "budgetBar", "Budget progress bar", true),
    thr("budgetUsed", "Budget used", "above", "% of budget", 1, 200, 1, 80, 100),
  ]),
  def("cost.spend", "Spend over time", [
    bool("data", "forecast", "Forecast bars", true),
    bool("data", "budgetLine", "Daily budget line", true),
    bool("data", "previous", "Previous period line at start", false),
    bool("display", "note", "Note line", true),
    bool("display", "legend", "Legend", true),
  ]),
  // Version 2: "Percentages in legend" is the legend's share column (on, as today); version 1's added a
  // second share beside each amount (off by default). Neither v1 value means the same, so it is dropped.
  def("cost.breakdown", "Spend breakdown", [pick("data", "groupBy", "Group by", o(["auto", "Auto"], ["region", "Region"]), "auto"), bool("display", "percentages", "Percentages in legend", true)], {
    version: 2,
    migrate: (from, s) => {
      if (from !== 1) return null;
      const { percentages: _dropped, ...rest } = s;
      return rest;
    },
  }),
  def("cost.forecast", "Forecast vs budget", [bool("display", "chart", "Month-so-far chart", true), thr("forecast", "Forecast vs budget", "above", "% of budget", 1, 200, 1, null, 100)]),
  def("cost.split", "Spend by region", [
    pick("data", "view", "Starting view", o(["region", "Region"], ["resource", "Resource type"]), "region"),
    pick("data", "order", "Order", o(["listed", "As Azure lists them"], ["largest", "Largest first"]), "listed"),
    bool("display", "tracks", "Track bars", true),
    bool("display", "percent", "Percent column", true),
  ]),
  def("cost.perSession", "Cost per session", [pick("data", "shown", "Sessions shown", o(["all", "All"], ["10", "Last 10"], ["20", "Last 20"], ["50", "Last 50"]), "all"), thr("session", "Session cost", "above", "£", 0, 500, 0.01, null, null)]),
  def("cost.insights", "Insights", []),
  def("cost.sessions", "Sessions", [
    pick("data", "status", "Starting status", o(["all", "All"], ["running", "Running"], ["ended", "Ended"]), "all"),
    pick("data", "sort", "Starting sort", o(["started", "Started, newest"], ["cost", "Estimated cost, highest"], ["duration", "Duration, longest"]), "started"),
    multi("data", "columns", "Columns", o(["region", "Region"], ["vmSize", "VM size"], ["duration", "Duration"], ["cost", "Estimated cost"], ["rate", "Cost / hour"], ["ended", "Ended"]), 0, ["region", "vmSize", "duration", "cost", "rate"]),
    pick("display", "density", "Density", DENSITY, "comfortable"),
  ]),
];

/** Each widget's one line for the Add widgets library (spec 9.1). */
const DESCRIPTIONS: Record<string, string> = {
  "overview.status": "The deployment's state, progress and auto-destroy time",
  "overview.topology": "Clients, tunnel, VM and home site as a live diagram",
  "overview.keyMetrics": "Endpoint, clients, latency, DNS, heartbeat, cost and availability",
  "overview.run": "The latest deploy or tear-down: its steps and log",
  "overview.traffic": "Data in and out of the tunnel over time",
  "overview.events": "The latest deploys, failures, changes and watchman notes",
  "overview.speedTest": "Recent speed tests from the VM",
  "overview.health": "VM, WireGuard, DNS, tunnel and self-test checks",
  "overview.costImpact": "What each recent session cost",
  "overview.notes": "What the watchman noticed and did",
  "overview.vmPerformance": "CPU, memory, network and disk as Azure measures them",
  "overview.azureHealth": "What Azure says about the VM: health, power, agent, maintenance",
  "overview.vitals": "Memory, disk, load, steal, connections, updates and internet from the VM",
  "clients.kpis": "Total, online, latency, full-tunnel, stale and expiring clients",
  "clients.table": "Every client with its address, handshake, latency and traffic",
  "clients.talkers": "The clients moving the most data this session",
  "clients.statusDonut": "Online, offline and expiring clients at a glance",
  "clients.sessionTraffic": "Client traffic in and out over time",
  "firewall.kpis": "Policy, default action, drops, published ports and capture",
  "firewall.rules": "The firewall rules, their hits and their order",
  "firewall.zones": "The network zones and the traffic allowed between them",
  "firewall.simulator": "Check whether some traffic would be allowed or dropped",
  "firewall.drops": "The latest packets the firewall dropped",
  "firewall.ports": "Ports opened from the internet through the VM",
  "firewall.capture": "Take a packet capture on the VM and download it",
  "firewall.publicIp": "Packets at Azure's edge and DDoS mitigation on the public IP",
  "activity.kpis": "Deploys, durations, success rate, failures, changes and problems",
  "activity.timeline": "Deploys, tear-downs, failures and changes over time",
  "activity.list": "Every run and activity entry, with filters",
  "activity.stream": "Events as they happen",
  "activity.changeLog": "Who changed which setting, and when",
  "activity.runDetails": "The steps of one run and how long each took",
  "activity.liveOutput": "The selected run's log output",
  "activity.azureChanges": "Who changed what in Azure, including the portal",
  "activity.serviceHealth": "Azure issues and planned maintenance in your region",
  "cost.kpis": "This session, month to date, forecast, budget and cost guard",
  "cost.spend": "Daily spend with the forecast and the budget",
  "cost.breakdown": "Where this month's money went",
  "cost.forecast": "The month's forecast against the budget",
  "cost.split": "Spend by region or by resource type",
  "cost.perSession": "What each session cost",
  "cost.insights": "Plain-English notes on your spending",
  "cost.sessions": "Every session with its region, size, duration and cost",
};

export const WIDGETS: readonly WidgetDef[] = CATALOGUE.map((x) => ({ ...x, description: DESCRIPTIONS[x.id] ?? "" }));

const w = (widget: string, weight = 1): LayoutItem => ({ widget, weight });

/** Each page's rows with today's weights (fr units or column spans). */
export const LAYOUTS: Record<PageId, PageLayout> = {
  overview: {
    page: "overview",
    rows: [
      { id: "r1", items: [w("overview.status")] },
      { id: "r2", items: [w("overview.topology"), w("overview.keyMetrics")] },
      // The insights widgets join at the end with the weight of the widget they suggest replacing, and max keeps each row at its old count.
      { id: "r3", max: 3, items: [w("overview.run", 41), w("overview.traffic", 45), { stack: "side", weight: 32, widgets: ["overview.events", "overview.speedTest"] }, w("overview.vmPerformance", 45)] },
      { id: "r4", max: 3, items: [w("overview.health", 54), w("overview.costImpact", 32), w("overview.notes", 32), w("overview.azureHealth", 32), w("overview.vitals", 32)] },
    ],
  },
  clients: {
    page: "clients",
    rows: [
      { id: "r1", items: [w("clients.kpis")] },
      { id: "r2", items: [w("clients.table")] },
      { id: "r3", items: [w("clients.talkers"), w("clients.statusDonut"), w("clients.sessionTraffic")] },
    ],
  },
  firewall: {
    page: "firewall",
    rows: [
      { id: "r1", items: [w("firewall.kpis")] },
      { id: "r2", items: [{ stack: "left", weight: 9, widgets: ["firewall.rules", "bottom"] }, { stack: "right", weight: 3, max: 3, widgets: ["firewall.drops", "firewall.ports", "firewall.capture", "firewall.publicIp"] }] },
      { id: "bottom", in: "left", items: [w("firewall.zones"), w("firewall.simulator")] },
    ],
  },
  activity: {
    page: "activity",
    rows: [
      { id: "r1", items: [w("activity.kpis")] },
      { id: "r2", items: [{ stack: "left", weight: 8, widgets: ["activity.timeline", "activity.list"] }, { stack: "right", weight: 4, max: 2, widgets: ["activity.stream", "activity.changeLog", "activity.azureChanges"] }] },
      { id: "r3", max: 2, items: [w("activity.runDetails", 3), w("activity.liveOutput", 2), w("activity.serviceHealth", 2)] },
    ],
  },
  cost: {
    page: "cost",
    rows: [
      { id: "r1", items: [w("cost.kpis")] },
      { id: "r2", items: [w("cost.spend", 5), w("cost.breakdown", 4), w("cost.forecast", 3)] },
      { id: "r3", items: [w("cost.split", 4), w("cost.perSession", 4), w("cost.insights", 4)] },
      { id: "r4", items: [w("cost.sessions")] },
    ],
  },
};

export const REGISTRY: Registry = { widgets: WIDGETS, layouts: LAYOUTS };

// ── Lookups ───────────────────────────────────────────────────────────────

/** The widget with this id, or undefined. */
export function widgetDef(id: string, reg: Registry = REGISTRY): WidgetDef | undefined {
  return reg.widgets.find((x) => x.id === id);
}

/** A page's widgets in catalogue order. */
export function pageWidgets(page: PageId, reg: Registry = REGISTRY): WidgetDef[] {
  return reg.widgets.filter((x) => x.page === page);
}

/** A layout item's key: the widget id or the stack id. */
export function itemKey(item: LayoutItem): string {
  return "widget" in item ? item.widget : item.stack;
}

/** A row's item keys in their declared order ([] for no such row). */
export function rowItemKeys(page: PageId, rowId: string, reg: Registry = REGISTRY): string[] {
  return reg.layouts[page]?.rows.find((r) => r.id === rowId)?.items.map(itemKey) ?? [];
}

// ── Visibility and capacity (insights spec 9.1, 9.3) ─────────────────────

/**
 * Whether a widget shows with these preferences: a default-off widget only
 * when `layout.shown` names it; any other unless `layout.hidden` does;
 * a pinned widget always.
 */
export function isVisible(prefs: PagePrefs, d: Pick<WidgetDef, "id" | "pinned" | "defaultOff">): boolean {
  if (d.pinned) return true;
  if (d.defaultOff) return !!prefs.layout?.shown?.includes(d.id);
  return !prefs.layout?.hidden?.includes(d.id);
}

/** Where a widget lives: its row (the row whose items hold it, directly or in a stack) and its stack, if any. `home` is the capacity unit: the stack's id, else the row's. */
export interface WidgetHome {
  page: PageId;
  row: string;
  stack: string | null;
  home: string;
}

/** The home of widget `id`, or null when no layout holds it. */
export function widgetHome(id: string, reg: Registry = REGISTRY): WidgetHome | null {
  const d = widgetDef(id, reg);
  if (!d) return null;
  for (const row of reg.layouts[d.page]?.rows ?? [])
    for (const it of row.items) {
      if ("widget" in it && it.widget === id) return { page: d.page, row: row.id, stack: null, home: row.id };
      if ("stack" in it && it.widgets.includes(id)) return { page: d.page, row: row.id, stack: it.stack, home: it.stack };
    }
  return null;
}

type Unit = { kind: "row"; row: LayoutRow } | { kind: "stack"; row: LayoutRow; stack: Extract<LayoutItem, { stack: string }> };

/** A page's row or stack with this id. */
function unitOf(page: PageId, home: string, reg: Registry): Unit | null {
  const rows = reg.layouts[page]?.rows ?? [];
  const row = rows.find((r) => r.id === home);
  if (row) return { kind: "row", row };
  for (const r of rows) for (const it of r.items) if ("stack" in it && it.stack === home) return { kind: "stack", row: r, stack: it };
  return null;
}

/** Every row and stack of a page, rows first. */
function unitsOf(page: PageId, reg: Registry): Unit[] {
  const rows = reg.layouts[page]?.rows ?? [];
  return [...rows.map((row): Unit => ({ kind: "row", row })), ...rows.flatMap((row) => row.items.flatMap((it): Unit[] => ("stack" in it ? [{ kind: "stack", row, stack: it }] : [])))];
}

/** A row's item keys, or a stack's members (widget ids and nested row ids), as declared. */
export function homeMembers(page: PageId, home: string, reg: Registry = REGISTRY): string[] {
  const u = unitOf(page, home, reg);
  if (!u) return [];
  return u.kind === "row" ? u.row.items.map(itemKey) : [...u.stack.widgets];
}

const isRowId = (page: PageId, id: string, reg: Registry) => (reg.layouts[page]?.rows ?? []).some((r) => r.id === id);

/** A nested row shows while anything in it does. */
function rowShows(page: PageId, rowId: string, prefs: PagePrefs, reg: Registry): boolean {
  const row = reg.layouts[page]?.rows.find((r) => r.id === rowId);
  return !!row && row.items.some((it) => ("widget" in it ? memberShows(page, it.widget, prefs, reg) : it.widgets.some((m) => memberShows(page, m, prefs, reg))));
}

/** A stack member (a widget, or a nested row) shows. */
function memberShows(page: PageId, m: string, prefs: PagePrefs, reg: Registry): boolean {
  if (isRowId(page, m, reg)) return rowShows(page, m, prefs, reg);
  const d = widgetDef(m, reg);
  return !!d && isVisible(prefs, d);
}

/** Every widget a row or stack holds, through stacks and nested rows. */
function widgetsUnder(page: PageId, keys: string[], reg: Registry): string[] {
  const rows = reg.layouts[page]?.rows ?? [];
  return keys.flatMap((k) => {
    const row = rows.find((r) => r.id === k);
    if (row) return widgetsUnder(page, row.items.map(itemKey), reg);
    for (const r of rows) for (const it of r.items) if ("stack" in it && it.stack === k) return widgetsUnder(page, it.widgets, reg);
    return [k];
  });
}

/** A row's item keys in the person's order: the saved order when it is a permutation of the row, else the declared one. */
function orderOf(row: LayoutRow, prefs: PagePrefs): string[] {
  const keys = row.items.map(itemKey);
  const saved = prefs.layout?.order?.[row.id];
  return saved && saved.length === keys.length && keys.every((k) => saved.includes(k)) ? [...saved] : keys;
}

/** What turning a widget on into a row or stack meets (spec 9.3). */
export interface Capacity {
  page: PageId;
  /** The row or stack id asked about. */
  home: string;
  kind: "row" | "stack";
  /** The most items it shows at once. */
  max: number;
  /** How many show now (a stack in a row counts as one while any member shows). */
  visible: number;
  /** visible >= max: turning another on means replacing one (the Replace modal). */
  full: boolean;
  /**
   * What Replace may turn off to make room, in the person's order: visible,
   * non-pinned widgets whose leaving frees a place. In a row: its widgets,
   * plus a stack's only visible widget. In a stack: its visible widgets.
   */
  candidates: string[];
  /** The candidate to preselect for `adding` (see suggestFor); null without `adding` or candidates. */
  suggestion: string | null;
}

function capacityOf(page: PageId, u: Unit, prefs: PagePrefs, reg: Registry, adding?: string): Capacity {
  const shows = (m: string) => memberShows(page, m, prefs, reg);
  const offerable = (m: string) => !isRowId(page, m, reg) && shows(m) && !widgetDef(m, reg)?.pinned;
  let max: number;
  let visible: number;
  let candidates: string[];
  if (u.kind === "row") {
    max = u.row.max ?? u.row.items.length;
    const items = orderOf(u.row, prefs).map((k) => u.row.items.find((it) => itemKey(it) === k)!);
    visible = items.filter((it) => ("widget" in it ? shows(it.widget) : it.widgets.some(shows))).length;
    candidates = items.flatMap((it) => {
      if ("widget" in it) return offerable(it.widget) ? [it.widget] : [];
      const on = it.widgets.filter(shows);
      return on.length === 1 && offerable(on[0]!) ? [on[0]!] : [];
    });
  } else {
    max = u.stack.max ?? u.stack.widgets.length;
    visible = u.stack.widgets.filter(shows).length;
    candidates = u.stack.widgets.filter(offerable);
  }
  const suggestion = adding ? suggestFor(adding, candidates, prefs, reg) : null;
  return { page, home: u.kind === "row" ? u.row.id : u.stack.stack, kind: u.kind, max, visible, full: visible >= max, candidates, suggestion };
}

/**
 * Replace's preselected widget for turning `adding` on (spec 9.3), first that applies:
 * 1. its `replaces`, when that is a candidate;
 * 2. a candidate whose `replaces` is `adding` (turning a widget back on swaps out what took its place);
 * 3. the candidate turned on most recently (the newest `layout.shown` entry);
 * 4. the row's last candidate in the person's order: the row's first is its lead widget (Health summary, Last run), the
 *    least sensible thing to offer away.
 */
function suggestFor(adding: string, candidates: string[], prefs: PagePrefs, reg: Registry): string | null {
  const preset = widgetDef(adding, reg)?.replaces;
  if (preset && candidates.includes(preset)) return preset;
  const tookItsPlace = candidates.find((c) => widgetDef(c, reg)?.replaces === adding);
  if (tookItsPlace) return tookItsPlace;
  const newest = [...(prefs.layout?.shown ?? [])].reverse().find((id) => candidates.includes(id));
  return newest ?? candidates.at(-1) ?? null;
}

/**
 * The capacity of row or stack `home` with these preferences. `adding`, the
 * widget about to be turned on, picks the suggestion. Throws for an id the
 * page does not have.
 */
export function rowCapacity(page: PageId, home: string, prefs: PagePrefs, adding?: string, reg: Registry = REGISTRY): Capacity {
  const u = unitOf(page, home, reg);
  if (!u) throw new Error(`No row or stack ${home} on the ${PAGE_TITLES[page]} page.`);
  return capacityOf(page, u, prefs, reg, adding);
}

/** The first row or stack showing more than its max, or null. */
export function overfullHome(page: PageId, prefs: PagePrefs, reg: Registry = REGISTRY): Capacity | null {
  for (const u of unitsOf(page, reg)) {
    const c = capacityOf(page, u, prefs, reg);
    if (c.visible > c.max) return c;
  }
  return null;
}

/** How a row or stack is named in a message: "Overview row 3", "The Firewall right column". */
function homeLabel(page: PageId, c: Capacity): string {
  if (c.kind === "stack") return `The ${PAGE_TITLES[page]} ${c.home} column`;
  const n = /^r(\d+)$/.exec(c.home);
  return n ? `${PAGE_TITLES[page]} row ${n[1]}` : `The ${PAGE_TITLES[page]} ${c.home} row`;
}

/** Every setting at its default: what a widget shows with nothing saved. */
export function widgetDefaults(id: string, reg: Registry = REGISTRY): Record<string, SettingValue> {
  const d = widgetDef(id, reg);
  if (!d) throw new Error(`No widget ${id}`);
  return Object.fromEntries(d.settings.map((s) => [s.key, cloneValue(s.default)]));
}

function cloneValue(v: SettingValue): SettingValue {
  if (Array.isArray(v)) return [...v];
  if (typeof v === "object" && v !== null) return { ...v };
  return v;
}

/**
 * The colour a threshold gives a value: "ok", "warn" (amber) or "bad"
 * (red); null when there is no value to judge (no data is not "ok").
 * Always show a word or icon beside the colour.
 */
export function thresholdTone(value: number | null | undefined, t: Threshold, direction: "above" | "below"): "ok" | "warn" | "bad" | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (direction === "above") {
    if (t.bad !== null && value >= t.bad) return "bad";
    if (t.warn !== null && value >= t.warn) return "warn";
    return "ok";
  }
  if (t.bad !== null && value < t.bad) return "bad";
  if (t.warn !== null && value < t.warn) return "warn";
  return "ok";
}

// ── Checking one value ────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function onStep(v: number, min: number, step: number): boolean {
  const q = (v - min) / step;
  return Math.abs(q - Math.round(q)) < 1e-6;
}

/** Why a number is not allowed, or null. `what` names it in the message. */
function numberProblem(v: unknown, min: number, max: number, step: number, what: string): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return `${what} must be a number.`;
  if (v < min || v > max) return `${what} must be ${min} to ${max}.`;
  if (!onStep(v, min, step)) return `${what} must be in steps of ${step}.`;
  return null;
}

/** Why a value is not allowed for this setting: [sub-field or "", message], or null. Strict. */
function valueProblem(s: SettingSpec, v: unknown): [string, string] | null {
  switch (s.kind) {
    case "boolean":
      return typeof v === "boolean" ? null : ["", `${s.label} must be true or false.`];
    case "enum":
      return typeof v === "string" && s.options.some((x) => x.value === v) ? null : ["", `${s.label} must be one of: ${s.options.map((x) => x.value).join(", ")}.`];
    case "number": {
      const p = numberProblem(v, s.min, s.max, s.step, s.label);
      return p ? ["", p] : null;
    }
    case "multi": {
      if (!Array.isArray(v)) return ["", `${s.label} must be a list.`];
      const seen = new Set<string>();
      for (const x of v) {
        if (typeof x !== "string" || !s.options.some((y) => y.value === x)) return ["", `${s.label} has an unknown choice: ${String(x)}.`];
        if (seen.has(x)) return ["", `${s.label} lists ${x} twice.`];
        seen.add(x);
      }
      if (v.length < s.minSelected) return ["", `${s.label} needs at least ${s.minSelected} choice${s.minSelected === 1 ? "" : "s"}.`];
      return null;
    }
    case "threshold": {
      if (!isObj(v) || Object.keys(v).length !== 2 || !own(v, "warn") || !own(v, "bad")) return ["", `${s.label} must have warn and bad (a number, or null for off).`];
      for (const k of ["warn", "bad"] as const) {
        if (v[k] === null) continue;
        const p = numberProblem(v[k], s.min, s.max, s.step, k === "warn" ? "Warn" : "Bad");
        if (p) return [`.${k}`, p];
      }
      const warn = v.warn as number | null;
      const bad = v.bad as number | null;
      if (warn !== null && bad !== null) {
        if (s.direction === "above" && !(warn < bad)) return ["", "Warn must be below Bad."];
        if (s.direction === "below" && !(warn > bad)) return ["", "Warn must be above Bad."];
      }
      return null;
    }
  }
}

/**
 * Why `value` cannot be saved for this setting (the message a form shows
 * at the field), or null when it can. The same strict rule the Worker uses.
 */
export function settingProblem(spec: SettingSpec, value: unknown): string | null {
  return valueProblem(spec, value)?.[1] ?? null;
}

/** The value in its stored form (a multi in the options' order, a threshold as {warn, bad}). */
function canonical(s: SettingSpec, v: SettingValue): SettingValue {
  if (s.kind === "multi") return s.options.map((x) => x.value).filter((x) => (v as string[]).includes(x));
  if (s.kind === "threshold") {
    const t = v as Threshold;
    return { warn: t.warn, bad: t.bad };
  }
  return v;
}

function sameValue(a: SettingValue, b: SettingValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── Layout helpers for both readers ───────────────────────────────────────

/** Rows whose order can be saved: two or more items. */
function orderableRows(page: PageId, reg: Registry) {
  return (reg.layouts[page]?.rows ?? []).filter((r) => r.items.length > 1);
}

// ── The lenient reader ────────────────────────────────────────────────────

/**
 * Saved preferences as this dashboard can use them, in sparse form: unknown
 * keys, unknown widgets and invalid values are dropped one by one; an entry
 * from an older version runs that widget's migration (or is dropped); a
 * stored order gains widgets added since (at their declared place); pinned
 * widgets are never hidden; anything equal to its default is left out.
 */
export function normalisePagePrefs(page: PageId, raw: unknown, reg: Registry = REGISTRY): PagePrefs {
  const out: PagePrefs = {};
  if (!isObj(raw)) return out;
  const defs = pageWidgets(page, reg);

  // Layout
  const layout: NonNullable<PagePrefs["layout"]> = {};
  if (isObj(raw.layout)) {
    const rawOrder = raw.layout.order;
    if (isObj(rawOrder)) {
      const order: Record<string, string[]> = {};
      for (const row of orderableRows(page, reg)) {
        const stored = rawOrder[row.id];
        if (!Array.isArray(stored)) continue;
        const keys = row.items.map(itemKey);
        const kept: string[] = [];
        for (const k of stored) if (typeof k === "string" && keys.includes(k) && !kept.includes(k)) kept.push(k);
        // Items the stored order lacks (added since it was saved) go back at their declared index.
        keys.forEach((k, i) => {
          if (!kept.includes(k)) kept.splice(Math.min(i, kept.length), 0, k);
        });
        if (kept.join("\n") !== keys.join("\n")) order[row.id] = kept;
      }
      if (Object.keys(order).length) layout.order = order;
    }
    if (Array.isArray(raw.layout.hidden)) {
      const asked = raw.layout.hidden.filter((x): x is string => typeof x === "string");
      const hidden = defs.filter((d) => !d.pinned && !d.defaultOff && asked.includes(d.id)).map((d) => d.id);
      if (hidden.length) layout.hidden = hidden;
    }
    // shown keeps its saved order: the last entry is the newest, the first to go from an over-full row.
    if (Array.isArray(raw.layout.shown)) {
      const shown: string[] = [];
      for (const x of raw.layout.shown) if (typeof x === "string" && !shown.includes(x) && defs.some((d) => d.id === x && d.defaultOff)) shown.push(x);
      // An over-full row or stack (saved by another dashboard, or a layout change since): drop its newest shown widgets.
      for (const u of unitsOf(page, reg)) {
        const inside = widgetsUnder(page, [u.kind === "row" ? u.row.id : u.stack.stack], reg);
        for (let c = capacityOf(page, u, { layout: { ...layout, shown } }, reg); c.visible > c.max; c = capacityOf(page, u, { layout: { ...layout, shown } }, reg)) {
          let i = shown.length - 1;
          while (i >= 0 && !inside.includes(shown[i]!)) i--;
          if (i < 0) break;
          shown.splice(i, 1);
        }
      }
      if (shown.length) layout.shown = shown;
    }
  }
  if (Object.keys(layout).length) out.layout = layout;

  // Widgets
  const widgets: NonNullable<PagePrefs["widgets"]> = {};
  if (isObj(raw.widgets)) {
    for (const d of defs) {
      if (!own(raw.widgets, d.id)) continue;
      const entry = raw.widgets[d.id];
      if (!isObj(entry) || !isObj(entry.s) || typeof entry.v !== "number") continue;
      let s: Record<string, unknown> | null = entry.s;
      if (entry.v !== d.version) {
        if (entry.v > d.version || !d.migrate) continue;
        try {
          s = d.migrate(entry.v, { ...entry.s });
        } catch {
          s = null;
        }
        if (!isObj(s)) continue;
      }
      const kept: Record<string, SettingValue> = {};
      for (const spec of d.settings) {
        if (!own(s, spec.key)) continue;
        let v = s[spec.key];
        // Lenient on a multi: unknown or repeated choices are dropped, the rest kept.
        if (spec.kind === "multi" && Array.isArray(v)) v = spec.options.map((x) => x.value).filter((x) => (v as unknown[]).includes(x));
        if (valueProblem(spec, v)) continue;
        const c = canonical(spec, v as SettingValue);
        if (!sameValue(c, spec.default)) kept[spec.key] = c;
      }
      if (Object.keys(kept).length) widgets[d.id] = { v: d.version, s: kept };
    }
  }
  if (Object.keys(widgets).length) out.widgets = widgets;
  return out;
}

// ── The strict checker ────────────────────────────────────────────────────

const OUTDATED = "This tab is running an older dashboard. Reload to change widget settings.";

/**
 * Null when `prefs` is a page's preferences exactly as this dashboard saves
 * them; otherwise the first problem, with the field at fault. An entry from
 * an older dashboard is reported first, as outdated (the Worker answers 409
 * so the tab knows to reload rather than show a form error).
 */
export function validatePagePrefs(page: PageId, prefs: unknown, reg: Registry = REGISTRY): PrefsProblem | null {
  const pageName = PAGE_TITLES[page];
  if (!isObj(prefs)) return { field: "prefs", message: "Preferences must be a JSON object." };
  const defs = pageWidgets(page, reg);

  // Saved by an older dashboard: say so before anything else.
  if (isObj(prefs.widgets)) {
    for (const [id, entry] of Object.entries(prefs.widgets)) {
      const d = defs.find((x) => x.id === id);
      if (d && isObj(entry) && typeof entry.v === "number" && Number.isInteger(entry.v) && entry.v < d.version) return { field: `widgets.${id}.v`, message: OUTDATED, outdated: true };
    }
  }

  for (const k of Object.keys(prefs)) if (k !== "layout" && k !== "widgets") return { field: k, message: `Unknown key "${k}".` };

  if (own(prefs, "layout")) {
    const layout = prefs.layout;
    if (!isObj(layout)) return { field: "layout", message: "layout must be an object." };
    for (const k of Object.keys(layout)) if (k !== "order" && k !== "hidden" && k !== "shown") return { field: `layout.${k}`, message: `Unknown key "${k}" in layout.` };
    if (own(layout, "order")) {
      const order = layout.order;
      if (!isObj(order)) return { field: "layout.order", message: "order must be an object of row id to item list." };
      const rows = reg.layouts[page]?.rows ?? [];
      for (const [rowId, list] of Object.entries(order)) {
        const row = rows.find((r) => r.id === rowId);
        if (!row) return { field: `layout.order.${rowId}`, message: `No row ${rowId} on the ${pageName} page.` };
        const keys = row.items.map(itemKey);
        const ok = Array.isArray(list) && list.length === keys.length && keys.every((k) => list.includes(k));
        if (!ok) return { field: `layout.order.${rowId}`, message: `The order must list each of ${keys.join(", ")} once.` };
      }
    }
    if (own(layout, "hidden")) {
      const hidden = layout.hidden;
      if (!Array.isArray(hidden)) return { field: "layout.hidden", message: "hidden must be a list of widget ids." };
      const seen = new Set<string>();
      for (const id of hidden) {
        const d = typeof id === "string" ? defs.find((x) => x.id === id) : undefined;
        if (!d) return { field: "layout.hidden", message: `No widget ${String(id)} on the ${pageName} page.` };
        if (d.pinned) return { field: "layout.hidden", message: `${d.title} can't be hidden.` };
        if (d.defaultOff) return { field: "layout.hidden", message: `${d.title} is off by default: leave it out of shown instead.` };
        if (seen.has(d.id)) return { field: "layout.hidden", message: `${d.id} is listed twice.` };
        seen.add(d.id);
      }
    }
    if (own(layout, "shown")) {
      const shown = layout.shown;
      if (!Array.isArray(shown)) return { field: "layout.shown", message: "shown must be a list of widget ids." };
      const seen = new Set<string>();
      for (const id of shown) {
        const d = typeof id === "string" ? defs.find((x) => x.id === id) : undefined;
        if (!d) return { field: "layout.shown", message: `No widget ${String(id)} on the ${pageName} page.` };
        if (!d.defaultOff) return { field: "layout.shown", message: `${d.title} is on by default: turn it off with hidden, not shown.` };
        if (seen.has(d.id)) return { field: "layout.shown", message: `${d.id} is listed twice.` };
        seen.add(d.id);
      }
    }
    const full = overfullHome(page, prefs as PagePrefs, reg);
    if (full) return { field: "layout.shown", message: `${homeLabel(page, full)} is full. Turn a widget off first.` };
  }

  if (own(prefs, "widgets")) {
    const widgets = prefs.widgets;
    if (!isObj(widgets)) return { field: "widgets", message: "widgets must be an object of widget id to settings." };
    for (const [id, entry] of Object.entries(widgets)) {
      const field = `widgets.${id}`;
      const d = defs.find((x) => x.id === id);
      if (!d) return { field, message: `No widget ${id} on the ${pageName} page.` };
      if (!isObj(entry) || Object.keys(entry).length !== 2 || !own(entry, "v") || !own(entry, "s")) return { field, message: "Each widget's settings are { v, s }: the settings version and the values." };
      if (entry.v !== d.version) return { field: `${field}.v`, message: `${d.title} settings version must be ${d.version}.` };
      if (!isObj(entry.s)) return { field: `${field}.s`, message: "s must be an object of setting to value." };
      for (const [key, v] of Object.entries(entry.s)) {
        const spec = d.settings.find((x) => x.key === key);
        if (!spec) return { field: `${field}.${key}`, message: `Unknown setting ${key} for ${d.title}.` };
        const p = valueProblem(spec, v);
        if (p) return { field: `${field}.${key}${p[0]}`, message: p[1] };
      }
    }
  }
  return null;
}
