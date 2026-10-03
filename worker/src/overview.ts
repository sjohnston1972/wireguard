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

/** How long a freshly started or resumed VM may stay silent before that counts as missing. */
export const BOOT_GRACE_MS = 5 * 60_000;

/**
 * Running, and the heartbeat is missing: none from this session within the
 * boot grace, or none for over 2 minutes since the last one. A heartbeat from
 * before this session started (an earlier run) counts as none, so a booting or
 * resumed VM is not called unreachable before it has had time to report.
 */
export function heartbeatStale(s: Snapshot, now = Date.now()): boolean {
  return heartbeatProblem(s, now) !== null;
}

/**
 * Why the heartbeat counts as missing: "boot" when none arrived within the
 * boot grace of this session starting, "silent" when one did but over 2
 * minutes ago. With no start time on record at all, the plain 2-minute rule
 * applies. Null when all is well (or the VM is not running).
 */
export function heartbeatProblem(s: Snapshot, now = Date.now()): "boot" | "silent" | null {
  if (s.state !== "running") return null;
  const start = Date.parse(s.running_since ?? s.since ?? "");
  const last = s.last_agent_at ? Date.parse(s.last_agent_at) : NaN;
  if (!Number.isFinite(start)) return !Number.isFinite(last) || now - last > 120_000 ? "silent" : null;
  if (!(last >= start)) return now - start > BOOT_GRACE_MS ? "boot" : null;
  return now - last > 120_000 ? "silent" : null;
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
