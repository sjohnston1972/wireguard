import type { ClientsResponse } from "@shared/api";
import type { PillStatus, SortState, Tone } from "@/components";

// Pure helpers for the Clients view: status words, filters, search, sort
// keys, sizes and times, and the exact routes a config will send.

export type Client = ClientsResponse["clients"][number];
export type ClientsConfig = ClientsResponse["config"];

// ── Status ──

export interface StatusWord {
  pill: PillStatus;
  label: string;
  tone: Tone;
  /** Why, for a tooltip. */
  hint?: string;
}

/** The status column's word (spec §8.2): online, offline, disabled, expired, loading onto VM, unknown. */
export function statusWord(c: Client): StatusWord {
  switch (c.status) {
    case "online":
      return { pill: "online", label: "Online", tone: "green" };
    case "offline":
      return { pill: "offline", label: "Offline", tone: "red" };
    case "disabled":
      return { pill: "stopped", label: "Disabled", tone: "grey", hint: "Switched off: its config does not work." };
    case "expired":
      return { pill: "stopped", label: "Expired", tone: "amber", hint: "Its time ran out: its config does not work." };
    case "loading":
      return { pill: "pending", label: "Loading onto VM", tone: "amber", hint: "Switched on; the VM picks it up at the next heartbeat." };
    case "removing":
      return { pill: "pending", label: "Removing from VM", tone: "amber", hint: "Switched off; the VM drops it at the next heartbeat." };
    default:
      return { pill: "unknown", label: "Unknown", tone: "grey", hint: "The VM is not running, so nobody can be online." };
  }
}

// ── Filters ──

export type FilterKey = "all" | "online" | "offline" | "expiring" | "site" | "full" | "stale" | "latency";

export const FILTERS: Record<FilterKey, (c: Client) => boolean> = {
  all: () => true,
  online: (c) => c.status === "online",
  offline: (c) => c.status !== "online",
  expiring: (c) => c.expiresSoon,
  site: (c) => c.isSite,
  full: (c) => !!c.full_tunnel,
  stale: (c) => c.stale,
  latency: (c) => c.lastLatencyMs !== null,
};

/** The quick-filter tabs, in mockup order. */
export const TAB_FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "online", label: "Online" },
  { key: "offline", label: "Offline" },
  { key: "expiring", label: "Expiring" },
  { key: "site", label: "Home site" },
  { key: "full", label: "Full tunnel" },
];

/** Search by name, tunnel address (v4 or v6) or public key, ignoring case. */
export function matchesSearch(c: Client, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return [c.name, c.ip, c.ip6 ?? "", c.public_key].some((v) => v.toLowerCase().includes(s));
}

// ── Times and sizes ──

/** When the client last shook hands (epoch ms): the VM's report, else the remembered time, else null (never). */
export function lastHandshakeMs(c: Client): number | null {
  if (c.live && c.live.latest_handshake > 0) return c.live.latest_handshake * 1000;
  const t = c.last_handshake_at ? Date.parse(c.last_handshake_at) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** "just now", "5 minutes ago", "3 days ago". */
export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** 1234567 -> "1.2 MB" (decimal units, as the mockup). */
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${i === 0 ? v : v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")} ${units[i]}`;
}

/** What the client sent (↑) and received (↓) this session: the VM counts rx as what it got from the client. */
export function sessionTraffic(c: Client): { up: number; down: number } | null {
  return c.live ? { up: c.live.rx, down: c.live.tx } : null;
}

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const shortDate = (iso: string) => DATE.format(new Date(iso));

/** Whole days until `iso` (rounded up), never below 0. */
export function daysUntil(iso: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - now) / 86_400_000));
}

// ── Routes ──

/** A config's routing choices (the add-client wizard, the Configuration tab). */
export interface Routing {
  full_tunnel: boolean;
  home_lan: boolean;
  azure_vnet: boolean;
  tunnel_dns: boolean;
}

/**
 * Exactly what the config's AllowedIPs will be (the same rule as
 * clientAllowedIps in worker/src/peers.ts): full tunnel sends everything;
 * otherwise the tunnel subnet and the VM, plus the Azure network and the
 * home LAN when asked.
 */
export function allowedIpsFor(cfg: ClientsConfig, r: Pick<Routing, "full_tunnel" | "home_lan" | "azure_vnet">): string[] {
  if (r.full_tunnel) return ["0.0.0.0/0", "::/0"];
  return [cfg.subnet, `${cfg.loopbackIp}/32`]
    .concat(cfg.subnet6 ? [cfg.subnet6] : [])
    .concat(r.azure_vnet ? [cfg.vnetCidr] : [])
    .concat(r.home_lan && cfg.homeLanCidr ? [cfg.homeLanCidr] : []);
}

/** The routes column: what the config sends, or for the home site the networks reached through it. */
export const routesOf = (c: Client): string[] => (c.isSite ? c.siteRoutes : c.allowedIps);

export function clientType(c: Client): string {
  if (c.isSite) return "Home site";
  if (c.full_tunnel) return "Full tunnel";
  return "Standard client";
}

// ── Sorting ──

export type SortKey = "name" | "address" | "handshake" | "latency" | "traffic" | "expires";

/** Addresses sort numerically: 10.13.13.9 before 10.13.13.10. */
export const ipSortValue = (ip: string) => ip.split(".").reduce((n, part) => n * 256 + (Number(part) || 0), 0);

export const SORT_OPTIONS: { value: string; label: string; sort: SortState }[] = [
  { value: "name:asc", label: "Name (A → Z)", sort: { key: "name", dir: "asc" } },
  { value: "name:desc", label: "Name (Z → A)", sort: { key: "name", dir: "desc" } },
  { value: "address:asc", label: "Address", sort: { key: "address", dir: "asc" } },
  { value: "handshake:desc", label: "Last handshake (newest)", sort: { key: "handshake", dir: "desc" } },
  { value: "latency:asc", label: "Latency (lowest)", sort: { key: "latency", dir: "asc" } },
  { value: "traffic:desc", label: "Session traffic (most)", sort: { key: "traffic", dir: "desc" } },
  { value: "expires:asc", label: "Expires (soonest)", sort: { key: "expires", dir: "asc" } },
];

/** The total a client moved this session in the top-talkers list, by tunnel address. */
export function talkerTotals(talkers: ClientsResponse["talkers"]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of talkers) out.set(t.c, (out.get(t.c) ?? 0) + t.up + t.down + t.bu + t.bd);
  return out;
}
