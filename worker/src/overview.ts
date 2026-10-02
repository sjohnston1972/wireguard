// overview.ts
//
// Plain English: the Overview facts that are worked out rather than
// stored: "verifying" (up, but the boot self-test has not reported), a
// stale heartbeat, the public IPv6 address, who may SSH in, and how long a
// deploy or tear-down usually takes. Shared by the page and the data API.

import type { Snapshot } from "./state";
import type { Run } from "./db";

/**
 * Running, but the VM's boot self-test has not reported yet: show
 * "Verifying" rather than a green "Running". Builds from before the
 * self-test never report one, so after 5 minutes it stops waiting.
 */
export function isVerifying(s: Snapshot, now = Date.now()): boolean {
  if (s.state !== "running" || s.selftest) return false;
  const since = Date.parse(s.running_since ?? s.since ?? "");
  return Number.isFinite(since) && now - since < 5 * 60_000;
}

/** Running, and no heartbeat for over 2 minutes. */
export function heartbeatStale(s: Snapshot, now = Date.now()): boolean {
  return s.state === "running" && (!s.last_agent_at || now - Date.parse(s.last_agent_at) > 120_000);
}

/**
 * The VM's public IPv6 address, from Azure's inventory. The address the VM
 * itself reports (agent.wan6) is its private one: Azure translates IPv6 at
 * the edge as it does IPv4. Shown only when the VM also reports IPv6
 * working inside, so a half-built stack is not advertised.
 */
export function publicIp6(s: Snapshot): string | null {
  if (!s.agent?.wan6) return null;
  const a = s.azure?.resources.find((r) => r.kind === "Public IPv6")?.detail.split(",")[0]?.trim();
  return a && a.includes(":") ? a : null;
}

/** The address allowed to SSH in: Azure's live NSG rule if known, else what the deploy asked for. */
export function sshAllowedFrom(s: Snapshot, payloadJson: string | null): string | null {
  const live = s.azure?.resources.find((r) => r.kind === "Network security group")?.detail.match(/allow tcp 22 from ([^;]+)/)?.[1];
  if (live) return live;
  try {
    const p = JSON.parse(payloadJson ?? "{}") as { ssh_allowed_cidr?: unknown };
    return p.ssh_allowed_cidr ? String(p.ssh_allowed_cidr) : null;
  } catch {
    return null;
  }
}

/** Median seconds of the last 10 successful runs of this kind, or null with none to go on. */
export function typicalSeconds(runs: Run[], action: "apply" | "destroy"): number | null {
  const secs = runs
    .filter((r) => r.action === action && r.status === "success" && r.finished_at)
    .slice(0, 10)
    .map((r) => (Date.parse(r.finished_at!) - Date.parse(r.started_at ?? r.requested_at)) / 1000)
    .filter((s) => Number.isFinite(s) && s >= 0)
    .sort((a, b) => a - b);
  if (!secs.length) return null;
  const mid = Math.floor(secs.length / 2);
  return Math.round(secs.length % 2 ? secs[mid] : (secs[mid - 1] + secs[mid]) / 2);
}
