// shared/verdict.ts
//
// Plain English: the Health summary's head line. Today it says "All systems
// healthy", "N checks failing" or "No health data". With Azure and the VM's
// own vitals it can say what is actually wrong ("Azure will reboot the VM at
// 13:15"). The rules run in order and the first match wins; when none of the
// new rules applies (always, with no Azure or vitals data) the head is
// exactly today's. Spec: docs/superpowers/specs/2026-10-04-azure-insights-design.md
// section 10.3. Thresholds colour this dashboard only.
//
// Pure: no React, no Worker code.

import type { AzureSummaryResponse, CapacityCheck, PagePrefs, ScheduledEvent } from "./api";
import { isVisible, thresholdTone, widgetDef, widgetDefaults, type Threshold } from "./widgets";

export type VerdictTone = "green" | "amber" | "red" | "grey";

export interface Head {
  tone: VerdictTone;
  title: string;
  sub: string;
}

/** One health check as the Health summary shows it; ok null = not known. */
export interface VerdictCheck {
  key: string;
  name: string;
  ok: boolean | null;
}

/** The thresholds the verdict judges by: VM performance's (perf) and System vitals' (vitals). */
export interface VerdictThresholds {
  perf: Record<string, Threshold>;
  vitals: Record<string, Threshold>;
}

export interface VerdictInput {
  /** The snapshot's state ("running", "destroyed", ...). */
  state: string;
  /** The checks the Health summary shows (its Checks setting). */
  checks: VerdictCheck[];
  azure?: AzureSummaryResponse | null;
  /** The next deploy's capacity check (OverviewResponse.capacity). */
  capacity?: CapacityCheck | null;
  /** Default: every threshold at its default (verdictThresholds({})). */
  thresholds?: VerdictThresholds;
  now: number;
}

export interface Verdict extends Head {
  /** Which rule matched (1-13). */
  rule: number;
  /** Rule 1: the sub-line ends with a Boot log link. */
  bootLog: boolean;
}

/** Today's head, from the checks shown. */
export function todayHead(state: string, checks: VerdictCheck[]): Head {
  const bad = checks.filter((c) => c.ok === false);
  if (!checks.some((c) => c.ok !== null)) return { tone: "grey", title: "No health data", sub: state === "running" ? "Waiting for the first heartbeat." : "Nothing is running to check." };
  if (bad.length) return { tone: "red", title: `${bad.length} check${bad.length === 1 ? "" : "s"} failing`, sub: bad.map((c) => c.name).join(", ") };
  return { tone: "green", title: "All systems healthy", sub: "Running and responding normally." };
}

function pick(prefs: PagePrefs, id: string): Record<string, Threshold> {
  const def = widgetDef(id)!;
  const s = isVisible(prefs, def) ? { ...widgetDefaults(id), ...(prefs.widgets?.[id]?.s ?? {}) } : widgetDefaults(id);
  const out: Record<string, Threshold> = {};
  for (const spec of def.settings) if (spec.kind === "threshold") out[spec.key] = s[spec.key] as Threshold;
  return out;
}

/** The Overview's saved thresholds for VM performance and System vitals; a widget that is off gives its defaults. */
export function verdictThresholds(prefs: PagePrefs): VerdictThresholds {
  return { perf: pick(prefs, "overview.vmPerformance"), vitals: pick(prefs, "overview.vitals") };
}

const VERB: Record<ScheduledEvent["type"], string> = { Reboot: "reboot", Redeploy: "redeploy", Freeze: "pause", Preempt: "evict", Terminate: "delete" };
const ukTime = (ms: number, withDate: boolean) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(withDate ? { day: "numeric", month: "short" } : {}) }).format(new Date(ms)).replace(" at ", ", ");
const n = (v: number) => String(Math.round(v * 10) / 10);
const max = (vals: (number | null)[]): number | null => vals.reduce<number | null>((m, v) => (v === null ? m : m === null ? v : Math.max(m, v)), null);

type Level = "ok" | "warn" | "bad" | null;
interface Reading {
  level: Level;
  /** Rule 8 (at bad) title, if this reading has one. */
  badTitle?: string;
  /** Rule 11 title. */
  title: string;
  sub: string;
}

export function verdict(input: VerdictInput): Verdict {
  const { state, checks, azure, capacity, now } = input;
  const th = input.thresholds ?? verdictThresholds({});
  const today = todayHead(state, checks);
  const running = state === "running";
  const out = (rule: number, h: Partial<Head> & { tone: VerdictTone }, bootLog = false): Verdict => ({ title: today.title, sub: today.sub, ...h, rule, bootLog });
  const health = azure?.health ?? null;
  const v = azure?.vitals ?? null;
  const latest = azure?.latest;

  // 1. The VM does not answer: today's words, plus what Azure says and the boot log.
  if (running && checks.some((c) => c.key === "vm" && c.ok === false)) return out(1, { tone: "red", sub: today.sub + (health?.title ? ` · Azure says: ${health.title}` : "") }, true);
  // 2. Azure says the VM is down.
  if (health?.state === "Unavailable") return out(2, { tone: "red", title: "Azure reports the VM as unavailable", sub: health.summary ?? "" });
  // 3. Any other failing check: today's head.
  if (today.tone === "red") return out(3, { tone: "red" });
  // 4. DDoS.
  if (latest?.underDdos === true) return out(4, { tone: "red", title: "Azure is mitigating a DDoS attack on the public IP", sub: "Traffic to the public IP is being filtered at Azure's edge." });
  // 5. No internet: every target loses at least the bad level.
  const targets = v?.net?.targets ?? [];
  const lossBad = th.vitals.loss?.bad ?? null;
  if (lossBad !== null && targets.length > 0 && targets.every((t) => t.lossPct !== null && t.lossPct >= lossBad)) return out(5, { tone: "red", title: "The VM can't reach the internet", sub: `No reply from ${targets.map((t) => t.ip).join(" or ")}.` });
  // 6. A scheduled event has started, or starts within 15 minutes.
  const events = azure?.maintenance ?? [];
  const at = (e: ScheduledEvent) => (e.notBefore ? Date.parse(e.notBefore) : NaN);
  const soon = events.find((e) => e.status === "Started" || at(e) <= now + 15 * 60_000);
  if (soon) {
    const t = at(soon);
    return out(6, { tone: "red", title: `Azure will ${VERB[soon.type]} the VM ${soon.status === "Started" || !Number.isFinite(t) ? "now" : `at ${ukTime(t, false)}`}`, sub: soon.description ?? "Scheduled by Azure. wg-admin never brings it forward." });
  }
  // 7. Azure says the VM is degraded.
  if (health?.state === "Degraded") return out(7, { tone: "amber", title: "Azure reports the VM as degraded", sub: health.summary ?? "" });

  // The figures, in rule 11's order (credits, CPU, memory, disk, steal, conntrack, latency, loss, security updates).
  const ct = v?.conntrack && v.conntrack.max > 0 ? (v.conntrack.count / v.conntrack.max) * 100 : null;
  const rtt = max(targets.map((t) => t.rttMs));
  const loss = max(targets.map((t) => t.lossPct));
  const sec = v?.updates?.security ?? null;
  const read = (value: number | null, t: Threshold | undefined, dir: "above" | "below", title: string, sub: string, badTitle?: string): Reading => ({ level: t ? thresholdTone(value, t, dir) : null, title, sub, badTitle });
  const readings: Reading[] = [
    read(latest?.creditsLeft ?? null, th.perf.credits, "below", "CPU credits running low", `${n(latest?.creditsLeft ?? 0)} credits left`, "CPU credits nearly gone: the VM will slow to its baseline speed"),
    read(latest?.cpuPct ?? null, th.perf.cpu, "above", "CPU busy", `${n(latest?.cpuPct ?? 0)}% used`),
    read(v?.memUsedPct ?? null, th.vitals.memory, "above", "Memory use high", `${n(v?.memUsedPct ?? 0)}% used`, "Memory nearly full on the VM"),
    read(v?.diskUsedPct ?? null, th.vitals.disk, "above", "Disk use high", `${n(v?.diskUsedPct ?? 0)}% used`, "Disk nearly full on the VM"),
    read(v?.stealPct ?? null, th.vitals.steal, "above", "CPU steal high", `${n(v?.stealPct ?? 0)}% of CPU time taken by the host`),
    read(ct, th.vitals.conntrack, "above", "Connection tracking table filling", `${v?.conntrack?.count ?? 0} of ${v?.conntrack?.max ?? 0} entries`, "Connection tracking table nearly full"),
    read(rtt, th.vitals.latency, "above", "Internet latency high", `${n(rtt ?? 0)} ms`),
    read(loss, th.vitals.loss, "above", "Internet packet loss", `${n(loss ?? 0)}% of pings lost`),
    read(sec, th.vitals.securityUpdates, "above", "Security updates waiting", `${sec ?? 0} to install`),
  ];

  // 8. Credits, memory, disk or conntrack at bad.
  const critical = readings.find((r) => r.badTitle && r.level === "bad");
  if (critical) return out(8, { tone: "amber", title: critical.badTitle, sub: critical.sub });
  // 9. An active Service Health issue in the region.
  const issue = azure?.serviceIssues?.[0];
  if (issue) return out(9, { tone: "amber", title: `Azure has an active issue in ${azure!.region.name}`, sub: issue.title });
  // 10. A later scheduled event.
  const later = events[0];
  if (later) {
    const t = at(later);
    return out(10, { tone: "amber", title: Number.isFinite(t) ? `Azure maintenance planned for ${ukTime(t, true)}` : "Azure maintenance planned", sub: later.description ?? `A ${VERB[later.type]} scheduled by Azure.` });
  }
  // 11. Any threshold past warn: the most severe, in order.
  const worst = readings.find((r) => r.level === "bad") ?? readings.find((r) => r.level === "warn");
  if (worst) return out(11, { tone: "amber", title: worst.title, sub: worst.sub });
  // 12. Nothing running and the next deploy may not get its VM.
  if ((state === "destroyed" || state === "failed" || state === "standby") && capacity?.ok === false && capacity.message) return out(12, { tone: "amber", title: `The next deploy may fail: ${capacity.message}` });
  // 13. Today's head.
  return out(13, { tone: today.tone });
}
