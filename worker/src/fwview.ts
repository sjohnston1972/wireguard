// fwview.ts
//
// Plain English: what the Firewall screen reads off the stored state: where
// the rule set stands on the VM (applied, pending, refused...), a rule's
// running hit total, and how many drops the default rule made lately. The
// old page and the data API both use these, so they always agree.

import type { Env } from "./env";
import type { Snapshot } from "./state";

export type PolicyState = "not_running" | "no_firewall" | "refused" | "applied" | "pending";

/** Where the rule set stands on the VM, with the sentence the screen shows. */
export function policyState(snap: Snapshot, hash: string): { state: PolicyState; text: string } {
  const fw = snap.firewall;
  if (snap.state !== "running") return { state: "not_running", text: "Not running: this rule set is loaded at the next deploy or resume." };
  if (!fw) return { state: "no_firewall", text: "This VM was built before the firewall existed: redeploy to use it." };
  if (fw.error) return { state: "refused", text: `The VM refused the last rule set and kept the previous one: ${fw.error}` };
  if (fw.applied_hash === hash) return { state: "applied", text: `Applied on the VM (rule set ${hash.slice(0, 8)}).` };
  return { state: "pending", text: "Changed: the VM picks it up within 30 seconds." };
}

/** A rule's running total: carried-over hits plus the VM's current counter. */
export function totalHits(snap: Snapshot, key: string): [number, number] | null {
  const c = snap.firewall?.counters[key];
  const b = snap.fw_base?.[key];
  if (!c && !b) return null;
  return [Math.max(0, (c?.[0] ?? 0) + (b?.[0] ?? 0)), Math.max(0, (c?.[1] ?? 0) + (b?.[1] ?? 0))];
}

/** Drops the default rule made since a time (from the history table; an index search on the time). */
export async function dropsSince(env: Env, sinceIso: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM hist_drops WHERE t >= ?1").bind(sinceIso).first<{ n: number }>();
  return Number(r?.n ?? 0);
}
