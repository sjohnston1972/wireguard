// labs/warnings.ts
//
// Plain English: the deploy modal's warnings (labs spec §9.2), in this order:
//
//   budget       "This session would take the month to £X of £Y" when the
//                month so far plus this session's estimate passes the budget.
//                Deploy anyway: overBudgetOk.
//   capacity     each of the lab's VM sizes against the stored capacity
//                reading for the region (offered, and the vCPU quota with the
//                sizes summed, plus the gateway's own when it is not built
//                now, so a lab never takes the vCPUs the gateway's next
//                deploy needs). Stored readings only: pages never call Azure.
//                Deploy anyway: capacityOk.
//   pricey       "Pricey: Azure Firewall, about £0.40/h" (information).
//   slow         deploy_min 15 or more (information).
//   unavailable  permissions, slots or labs_max_running (no override).

import type { Env, Config } from "../env";
import { effectiveConfig } from "../settings";
import { getSnapshot, type Snapshot } from "../state";
import { budgetStatus } from "../budget";
import { readCapacity, TEST_VM_SIZE } from "../insights/feeds/capacity";
import { azureRegionName } from "../region";
import type { CapacityDoc } from "../insights/types";
import { estimateGbpH, type LabDef } from "../../../shared/labs";
import type { LabWarning } from "../../../shared/api";
import { availability, unavailableReason } from "./availability";
import { gbpHFrom, readLabPrices, retailPrice } from "./prices";

const money = (n: number) => `£${n.toFixed(2)}`;

/** The month is at or over a set budget: no lab may deploy (the budget guard removes labs at 100%). */
export const budgetFull = (b: { total: number; budget: number }): boolean => b.budget > 0 && b.total >= b.budget;

/** The non-overridable budget warning's sentence, also the cards' budget blocker (labs redesign spec §6.1). */
export function budgetFullMessage(b: { total: number; budget: number }): string {
  return `This month is already at ${money(b.total)} of ${money(b.budget)}, and the budget guard removes labs at 100%. Raise the budget in Settings to deploy.`;
}

function familyWords(family: string): string {
  if (family === "standardBSFamily") return "B-series";
  return `${family.replace(/^standard/i, "").replace(/Family$/i, "")}-series`;
}

/** Gateway states with no VM in Azure (its vCPUs are not in the quota's "used" yet). */
const NO_GATEWAY_VM = new Set(["destroyed", "failed", "deploying"]);

/** The capacity problems for a lab's VM sizes in a region, from a stored reading; [] when it all fits or nothing is known. */
export function capacityProblems(doc: CapacityDoc, sizes: string[], gateway: string[], region: string): string[] {
  const place = azureRegionName(region);
  const out: string[] = [];
  const info = (name: string) => doc.sizes.find((s) => s.name === name) ?? null;
  for (const name of new Set(sizes)) {
    const s = info(name);
    if (s && !s.available) out.push(s.reason === "NotOffered" ? `${name} isn't offered in ${place}.` : `${name} isn't offered to this subscription in ${place} (${s.reason ?? "restricted"}).`);
  }
  if (out.length) return out;
  // vCPUs needed per family and in all: the lab's sizes (each entry one VM) plus the gateway's.
  const need = new Map<string, { lab: number; gw: number; names: Set<string> }>();
  const all = { lab: 0, gw: 0, names: new Set<string>() };
  for (const [list, who] of [[sizes, "lab"], [gateway, "gw"]] as const) {
    for (const name of list) {
      const s = info(name);
      if (!s?.vcpus || !s.family) continue;
      const n = need.get(s.family) ?? { lab: 0, gw: 0, names: new Set<string>() };
      n[who] += s.vcpus;
      all[who] += s.vcpus;
      if (who === "lab") {
        n.names.add(name);
        all.names.add(name);
      }
      need.set(s.family, n);
    }
  }
  const parts = (n: { lab: number; gw: number; names: Set<string> }) => `${n.lab} for this lab's ${[...n.names].join(", ")}${n.gw ? ` and ${n.gw} for the gateway's next deploy` : ""}`;
  for (const [family, n] of need) {
    const u = doc.usages.find((x) => x.family === family);
    if (u && n.lab > 0 && u.used + n.lab + n.gw > u.limit) out.push(`Needs ${n.lab + n.gw} ${familyWords(family)} vCPUs (${parts(n)}); ${u.used} of ${u.limit} used in ${place}.`);
  }
  if (!out.length && doc.cores && all.lab > 0 && doc.cores.used + all.lab + all.gw > doc.cores.limit) out.push(`Needs ${all.lab + all.gw} vCPUs (${parts(all)}); ${doc.cores.used} of ${doc.cores.limit} used in ${place}.`);
  return out;
}

async function capacityWarning(env: Env, def: LabDef, region: string, cfg: Config, snap: Snapshot): Promise<LabWarning | null> {
  if (!def.capacity.vm_sizes.length) return null;
  const have = await readCapacity(env.DB, region).catch(() => null);
  if (!have) return null;
  const gateway = NO_GATEWAY_VM.has(snap.state) && cfg.region === region ? [cfg.vmSize, ...(cfg.testVm ? [TEST_VM_SIZE] : [])] : [];
  const problems = capacityProblems(have.doc, def.capacity.vm_sizes, gateway, region);
  return problems.length ? { kind: "capacity", message: `May not be available: ${problems.join(" ")}`, overridable: true } : null;
}

/** The warnings for deploying `def` now for `hours` in `region`. */
export async function labWarnings(env: Env, def: LabDef, o: { hours: number; region: string }, now = new Date()): Promise<LabWarning[]> {
  const [cfg, snap, rows, avail] = await Promise.all([effectiveConfig(env), getSnapshot(env), readLabPrices(env, o.region), availability(env)]);
  const out: LabWarning[] = [];
  const b = await budgetStatus(env, cfg, snap, now);
  const gbpH = gbpHFrom(def, rows, o.region, now);
  if (budgetFull(b)) {
    // The budget guard tears labs down at 100%, so there is nothing to "Deploy anyway" into.
    out.push({ kind: "budget", message: budgetFullMessage(b), overridable: false });
  } else if (b.budget > 0 && b.total + gbpH * o.hours > b.budget) {
    out.push({ kind: "budget", message: `This session would take the month to ${money(b.total + gbpH * o.hours)} of ${money(b.budget)}.`, overridable: true });
  }
  const cap = await capacityWarning(env, def, o.region, cfg, snap);
  if (cap) out.push(cap);
  const pricey = def.cost.pricey ? def.cost.items.find((i) => i.name === def.cost.pricey) : undefined;
  if (pricey) out.push({ kind: "pricey", message: `Pricey: ${pricey.name}, about ${money(estimateGbpH([pricey], (i) => retailPrice(i, rows, o.region, now, def.regions.secondary)?.gbpH ?? null))}/h.`, overridable: false });
  if (def.timing.deploy_min >= 15) out.push({ kind: "slow", message: `Takes about ${def.timing.deploy_min} minutes to deploy and ${def.timing.destroy_min} to tear down.`, overridable: false });
  const why = unavailableReason(def, avail);
  if (why) out.push({ kind: "unavailable", message: why, overridable: false });
  return out;
}
