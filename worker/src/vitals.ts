// vitals.ts
//
// Plain English: the VM's own figures on the heartbeat (agent version 7 and
// later): memory, disk, CPU steal, connection tracking, pending updates,
// Azure's scheduled maintenance and an internet check. The agent is trusted
// to be ours, but not to be well-formed: every number here is type-checked
// and clamped, every string capped, and anything malformed becomes null
// (never 0, which would read as a real figure). parseVitals cannot throw, so
// a bad report can never cost the VM its heartbeat. Insights spec section 5.

import type { VmScheduledEvent, VmVitals } from "./state";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** A finite number in [min, max], clamped; anything else is null. */
function num(v: unknown, min: number, max: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, v));
}

/** A whole number in [min, max]; out of range or fractional is null. */
function int(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

/** Plain text, at most `max` characters: control characters become spaces, runs of space fold. */
function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, max).trim();
  return s === "" ? null : s;
}

/** A time the agent stamped, as ISO; null when it is not a time. */
function time(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 64) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const pct = (v: unknown) => num(v, 0, 100);
/** Bytes, up to a petabyte. */
const BYTES_MAX = 1e15;

function mem(v: unknown): VmVitals["mem"] {
  if (!isObj(v)) return null;
  const total = num(v.total, 0, BYTES_MAX);
  const available = num(v.available, 0, BYTES_MAX);
  if (!total || available === null) return null;
  return { total, available: Math.min(available, total) };
}

function disk(v: unknown): VmVitals["disk"] {
  if (!isObj(v)) return null;
  const total = num(v.total, 0, BYTES_MAX);
  const used = num(v.used, 0, BYTES_MAX);
  const avail = num(v.avail, 0, BYTES_MAX);
  if (!total || used === null || avail === null) return null;
  return { total, used: Math.min(used, total), avail: Math.min(avail, total) };
}

function cpu(v: unknown): VmVitals["cpu"] {
  if (!isObj(v)) return null;
  return { steal_pct: pct(v.steal_pct), iowait_pct: pct(v.iowait_pct), ncpu: int(v.ncpu, 1, 1024) };
}

function conntrack(v: unknown): VmVitals["conntrack"] {
  if (!isObj(v)) return null;
  const count = int(v.count, 0, 1e9);
  const max = int(v.max, 1, 1e9);
  if (count === null || max === null) return null;
  return { count: Math.min(count, max), max };
}

function updates(v: unknown): VmVitals["updates"] {
  if (!isObj(v)) return null;
  const pending = int(v.pending, 0, 100_000);
  const security = int(v.security, 0, 100_000);
  const at = time(v.at);
  if (pending === null || security === null || !at) return null;
  return { pending, security: Math.min(security, pending), at };
}

const EVENT_TYPES = new Set<VmScheduledEvent["type"]>(["Reboot", "Redeploy", "Freeze", "Preempt", "Terminate"]);

function event(v: unknown): VmScheduledEvent | null {
  if (!isObj(v)) return null;
  const id = text(v.id, 64);
  const type = v.type as VmScheduledEvent["type"];
  if (!id || !EVENT_TYPES.has(type)) return null;
  const duration = int(v.duration_s, 1, 7 * 86_400);
  return {
    id,
    type,
    status: text(v.status, 32) ?? "Scheduled",
    not_before: time(v.not_before),
    source: text(v.source, 32),
    duration_s: duration,
    description: text(v.description, 200),
    self: v.self === true,
  };
}

function events(v: unknown): VmVitals["events"] {
  if (!isObj(v)) return null;
  const at = time(v.at);
  if (!at) return null;
  const items = Array.isArray(v.items) ? v.items.slice(0, 50).map(event).filter((e): e is VmScheduledEvent => e !== null).slice(0, 10) : [];
  return { incarnation: int(v.incarnation, 0, 1e9), at, items };
}

/** An IPv4 or IPv6 address, by its characters (the agent pings fixed targets). */
const ADDRESS = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]{2,45})$/;

function net(v: unknown): VmVitals["net"] {
  if (!isObj(v)) return null;
  const at = time(v.at);
  const method = v.method === "icmp" || v.method === "tcp" ? v.method : null;
  if (!at || !method || !Array.isArray(v.targets)) return null;
  const targets = v.targets
    .slice(0, 20)
    .filter(isObj)
    .filter((t) => typeof t.ip === "string" && ADDRESS.test(t.ip))
    .slice(0, 4)
    .map((t) => ({ ip: t.ip as string, rtt_ms: num(t.rtt_ms, 0, 60_000), loss_pct: pct(t.loss_pct) }));
  return { at, method, targets };
}

/**
 * The heartbeat's `vitals`, checked. Null when it is absent or not an
 * object; each part on its own is null when missing or malformed. Never throws.
 */
export function parseVitals(raw: unknown): VmVitals | null {
  try {
    if (!isObj(raw)) return null;
    return { mem: mem(raw.mem), disk: disk(raw.disk), cpu: cpu(raw.cpu), conntrack: conntrack(raw.conntrack), updates: updates(raw.updates), events: events(raw.events), net: net(raw.net) };
  } catch {
    return null;
  }
}

/** The agent's version (7 and later send vitals); anything that is not a sensible whole number is null. */
export function parseAgentVersion(raw: unknown): number | null {
  return int(raw, 1, 10_000);
}

/** The six hist_vm columns one heartbeat's vitals fill (migration 0019). */
export interface VitalsSample {
  mem_used_pct: number | null;
  disk_used_pct: number | null;
  steal_pct: number | null;
  conntrack_pct: number | null;
  net_rtt_ms: number | null;
  net_loss_pct: number | null;
}

/** An internet check older than this is left out of history: the job behind it has stopped refreshing. */
export const NET_FRESH_MS = 15 * 60_000;

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * One heartbeat's vitals as hist_vm's percentages. Disk is df's "Use%"
 * (used out of used + available, so the space only root may use is left
 * out), which is what a person sees on the VM. The internet figures are the
 * mean across targets, and only while the check is fresh.
 */
export function vitalsSample(v: VmVitals | null | undefined, atMs: number): VitalsSample {
  const out: VitalsSample = { mem_used_pct: null, disk_used_pct: null, steal_pct: null, conntrack_pct: null, net_rtt_ms: null, net_loss_pct: null };
  if (!v) return out;
  if (v.mem) out.mem_used_pct = round(((v.mem.total - v.mem.available) / v.mem.total) * 100);
  if (v.disk && v.disk.used + v.disk.avail > 0) out.disk_used_pct = round((v.disk.used / (v.disk.used + v.disk.avail)) * 100);
  if (v.cpu) out.steal_pct = v.cpu.steal_pct;
  if (v.conntrack) out.conntrack_pct = round((v.conntrack.count / v.conntrack.max) * 100);
  if (v.net && Math.abs(atMs - Date.parse(v.net.at)) <= NET_FRESH_MS) {
    const rtt = mean(v.net.targets.map((t) => t.rtt_ms).filter((n): n is number => n !== null));
    const loss = mean(v.net.targets.map((t) => t.loss_pct).filter((n): n is number => n !== null));
    out.net_rtt_ms = rtt === null ? null : round(rtt);
    out.net_loss_pct = loss === null ? null : round(loss);
  }
  return out;
}

/** How many scheduled-event ids the snapshot remembers. */
export const SEEN_EVENTS_KEEP = 20;

/** The scheduled events not noted before, and the remembered ids with them added (the last 20). */
export function freshScheduledEvents(v: VmVitals | null | undefined, seen: string[] | undefined): { fresh: VmScheduledEvent[]; seen: string[] } {
  const known = seen ?? [];
  const fresh = (v?.events?.items ?? []).filter((e, i, all) => !known.includes(e.id) && all.findIndex((x) => x.id === e.id) === i);
  if (!fresh.length) return { fresh, seen: known };
  return { fresh, seen: [...known, ...fresh.map((e) => e.id)].slice(-SEEN_EVENTS_KEEP) };
}

/** The watchman note for a new scheduled event. wg-admin never approves one: approving brings it forward. */
export function scheduledEventNote(e: VmScheduledEvent): string {
  const when = e.not_before
    ? `not before ${new Date(e.not_before).toLocaleString("en-GB", { timeZone: "Europe/London", weekday: "short", hour: "2-digit", minute: "2-digit" })}`
    : "time not given yet";
  const length = e.duration_s ? `, about ${e.duration_s < 120 ? `${e.duration_s} s` : `${Math.round(e.duration_s / 60)} min`}` : "";
  const whose = e.self ? "this VM" : "another VM in its group";
  return `Azure scheduled a ${e.type} for ${whose}: ${when}${length}.${e.description ? ` ${e.description}` : ""}`;
}
