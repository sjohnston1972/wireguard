// The Firewall view's pure logic: one rule shape for the table whether it
// shows the live rules or the draft, the filter tabs, where a drag lands, and
// which zone-to-zone flows the rules allow. No React here.
import type { DraftRuleBody, FirewallResponse, SimEnd } from "@shared/api";

export type Zone = FirewallResponse["zones"][number]["zone"];
export type Action = "allow" | "deny";
export type Proto = DraftRuleBody["proto"];

/** One rule as the table and the drawer show it. */
export interface RuleView {
  id: number;
  place: number;
  name: string;
  enabled: boolean;
  log: boolean;
  from: SimEnd;
  to: SimEnd;
  proto: Proto;
  ports: string;
  action: Action;
  fromLabel: string;
  toLabel: string;
  service: string;
  problem: string | null;
  /** One of the rules a fresh install starts with ("Default" tab); everything else is "Custom". */
  starter: boolean;
  /** How the draft differs from live; null without a draft or when unchanged. */
  mark: "added" | "changed" | "moved" | null;
  /** Packets in the last 24 h; null when no hit history exists (no data, not 0). */
  hits24h: number | null;
  trend24h: (number | null)[];
}

/** The rows the table shows: the draft's when there is one, else the live rules. Hits come from the live rule a draft row copies. */
export function ruleViews(fw: FirewallResponse): RuleView[] {
  const live = new Map(fw.rules.map((r) => [r.id, r]));
  if (!fw.draft) {
    return fw.rules.map((r) => ({
      id: r.id,
      place: r.place,
      name: r.name,
      enabled: !!r.enabled,
      log: !!r.log,
      from: { kind: r.src_kind, value: r.src_value },
      to: { kind: r.dst_kind, value: r.dst_value },
      proto: r.proto,
      ports: r.ports,
      action: r.action,
      fromLabel: r.fromLabel,
      toLabel: r.toLabel,
      service: r.service,
      problem: r.problem,
      starter: r.starter,
      mark: null,
      hits24h: r.hits24h,
      trend24h: r.trend24h,
    }));
  }
  return fw.draft.rules.map((r) => {
    const l = r.liveId !== null ? live.get(r.liveId) : undefined;
    return {
      id: r.id,
      place: r.place,
      name: r.name,
      enabled: !!r.enabled,
      log: !!r.log,
      from: { kind: r.src_kind, value: r.src_value },
      to: { kind: r.dst_kind, value: r.dst_value },
      proto: r.proto,
      ports: r.ports,
      action: r.action,
      fromLabel: r.fromLabel,
      toLabel: r.toLabel,
      service: r.service,
      problem: r.problem,
      starter: !!l?.starter,
      mark: r.mark,
      hits24h: l ? l.hits24h : null,
      trend24h: l ? l.trend24h : [],
    };
  });
}

/** The default action in force on the screen: the draft's when there is one. */
export const shownDefault = (fw: FirewallResponse): Action => fw.draft?.defaultAction ?? fw.defaultAction;

export type RuleTab = "all" | "custom" | "default" | "disabled";

export interface RuleFilter {
  tab: RuleTab;
  q: string;
  zone: Zone | "all";
  action: Action | "all";
}
export const NO_FILTER: RuleFilter = { tab: "all", q: "", zone: "all", action: "all" };

export function tabCounts(rows: RuleView[]): Record<RuleTab, number> {
  return {
    all: rows.length,
    custom: rows.filter((r) => !r.starter).length,
    default: rows.filter((r) => r.starter).length,
    disabled: rows.filter((r) => !r.enabled).length,
  };
}

const endZone = (e: SimEnd): Zone | null => (e.kind === "zone" ? (e.value as Zone) : null);

export function filterRules(rows: RuleView[], f: RuleFilter): RuleView[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.tab === "custom" && r.starter) return false;
    if (f.tab === "default" && !r.starter) return false;
    if (f.tab === "disabled" && r.enabled) return false;
    if (f.action !== "all" && r.action !== f.action) return false;
    if (f.zone !== "all" && endZone(r.from) !== f.zone && endZone(r.to) !== f.zone) return false;
    if (q && ![r.name, r.fromLabel, r.toLabel, r.service, r.from.value, r.to.value].some((s) => s.toLowerCase().includes(q))) return false;
    return true;
  });
}

/** Whether the fixed default row shows under this filter (it is never disabled and belongs to no zone). */
export function showsDefaultRow(f: RuleFilter, action: Action): boolean {
  if (f.tab === "disabled" || f.zone !== "all") return false;
  if (f.action !== "all" && f.action !== action) return false;
  const q = f.q.trim().toLowerCase();
  return !q || "default (catch all) anywhere".includes(q);
}

/**
 * Where a dragged rule lands: the 0-based index in the full list that the
 * rule it was dropped on holds now (the moved rule takes that place). null
 * when nothing would change (dropped on itself) or either id is unknown.
 */
export function dropIndex(order: number[], dragged: number, target: number): number | null {
  const from = order.indexOf(dragged);
  const to = order.indexOf(target);
  if (from < 0 || to < 0 || from === to) return null;
  return to;
}

/** The address line under an end's label in the table. */
export function endAddress(end: SimEnd, zones: FirewallResponse["zones"]): string {
  if (end.kind === "any") return "0.0.0.0/0";
  if (end.kind === "zone") {
    const z = zones.find((x) => x.zone === end.value);
    // The internet is "everything but the private ranges": its v4 list is what it excludes.
    if (!z) return "";
    return z.negate ? "0.0.0.0/0" : z.v4.join(", ");
  }
  if (end.kind === "cidr") return end.value;
  return "";
}

/**
 * What the rules do with traffic from one zone to another, as the zones
 * panel draws it: the first enabled rule whose ends cover both zones whole
 * (any, or that zone) and which covers every protocol decides, else the
 * default action. A narrower rule (one port, one address) does not decide a
 * whole zone's flow.
 */
export function zoneFlow(rows: RuleView[], defaultAction: Action, from: Zone, to: Zone): Action {
  const covers = (e: SimEnd, z: Zone) => e.kind === "any" || (e.kind === "zone" && e.value === z);
  const hit = rows.find((r) => r.enabled && r.proto === "any" && covers(r.from, from) && covers(r.to, to));
  return hit ? hit.action : defaultAction;
}

/** The body a rule's edit form starts from. */
export function ruleBody(r: RuleView): Required<DraftRuleBody> {
  return { name: r.name, from: r.from, to: r.to, proto: r.proto, ports: r.ports, action: r.action, enabled: r.enabled, log: r.log };
}

/** Only the fields that differ, for PUT draft rule (an untouched form sends nothing). */
export function changedFields(before: Required<DraftRuleBody>, after: Required<DraftRuleBody>): Partial<DraftRuleBody> {
  const out: Partial<DraftRuleBody> = {};
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const k of Object.keys(after) as (keyof DraftRuleBody)[]) {
    if (!same(before[k], after[k])) (out as Record<string, unknown>)[k] = after[k];
  }
  return out;
}

export const fmtCount = (n: number): string => n.toLocaleString("en-GB");

/** "12%" up or down against the day before, or null when there is nothing to compare with. */
export function dropDelta(now: number, before: number): { text: string; direction: "up" | "down" } | null {
  if (!before) return null;
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return null;
  return { text: `${Math.abs(pct)}%`, direction: pct > 0 ? "up" : "down" };
}

export const ZONE_ORDER: Zone[] = ["clients", "home", "azure", "workloads", "internet"];

const ip4 = (s: string): number | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.some((x) => x > 255) ? null : p[0] * 2 ** 24 + p[1] * 2 ** 16 + p[2] * 2 ** 8 + p[3];
};

/** True when an IPv4 address is inside an IPv4 network ("10.13.13.0/24"). */
export function inCidr(ip: string, cidr: string): boolean {
  const [net, bits = "32"] = cidr.split("/");
  const a = ip4(ip);
  const n = ip4(net);
  const b = Number(bits);
  if (a === null || n === null || !(b >= 0 && b <= 32)) return false;
  const size = 2 ** (32 - b);
  return Math.floor(a / size) === Math.floor(n / size);
}

/** The zone an address belongs to (the internet when no private zone holds it). */
export function zoneOfIp(ip: string, zones: FirewallResponse["zones"]): Zone {
  // Workloads sit inside the Azure VNet: the narrower network wins.
  const hits = zones.filter((z) => !z.negate && z.v4.some((c) => inCidr(ip, c)));
  const bits = (z: (typeof zones)[number]) => Math.max(...z.v4.filter((c) => inCidr(ip, c)).map((c) => Number(c.split("/")[1] ?? 32)));
  hits.sort((a, b) => bits(b) - bits(a));
  return hits[0]?.zone ?? "internet";
}
