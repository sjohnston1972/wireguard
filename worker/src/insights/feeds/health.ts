// insights/feeds/health.ts
//
// Plain English: "what does Azure say about the VM?". Two calls every 5
// minutes while the resource group exists:
//   - Resource Health's current availability (Available, Degraded,
//     Unavailable or Unknown, with Azure's own title, summary and reason),
//   - the VM itself with its instance view: power and provisioning state,
//     the VM agent's status and version, and whether boot diagnostics are
//     on (from the VM's diagnosticsProfile; the instance view alone does
//     not say for managed storage).
// Stored as az_latest['health'] (HealthDoc). A VM that is not there yet
// (a deploy still building it) stores nothing and is not an error.

import type { FeedModule } from "../runner";
import type { FeedCtx, HealthDoc } from "../types";
import { armRefusal, paths, putLatest, str, time } from "../common";

const HEALTH_API = "2022-10-01";
const COMPUTE_API = "2024-07-01";
const STATES = ["Available", "Degraded", "Unavailable", "Unknown"] as const;

export interface HealthReplies {
  availability: unknown | null;
  vm: unknown | null;
}

/** The two replies; null for one Azure answers 404 to. */
export async function fetchHealth(ctx: FeedCtx): Promise<HealthReplies> {
  const p = paths(ctx.env, ctx.cfg);
  const a = await ctx.arm(`${p.vm}/providers/Microsoft.ResourceHealth/availabilityStatuses/current?api-version=${HEALTH_API}`);
  if (!a.ok && a.status !== 404) throw await armRefusal("the Resource Health check", a);
  const availability = a.ok ? await a.json() : null;
  const v = await ctx.arm(`${p.vm}?api-version=${COMPUTE_API}&$expand=instanceView`);
  if (!v.ok && v.status !== 404) throw await armRefusal("the VM's instance view", v);
  const vm = v.ok ? await v.json() : null;
  return { availability, vm };
}

type Status = { code?: unknown; displayStatus?: unknown };

function statusWith(list: unknown, prefix: string): string | null {
  if (!Array.isArray(list)) return null;
  const s = (list as Status[]).find((x) => typeof x?.code === "string" && x.code.startsWith(prefix));
  return s ? str(s.displayStatus, 80) ?? str(String(s.code).slice(prefix.length), 80) : null;
}

/** The two replies as the stored health document. */
export function normaliseHealth(availability: unknown, vm: unknown, now: Date): HealthDoc {
  const ap = (availability as { properties?: Record<string, unknown> } | null)?.properties ?? {};
  const stateRaw = typeof ap.availabilityState === "string" ? ap.availabilityState : "";
  const state = (STATES as readonly string[]).includes(stateRaw) ? (stateRaw as HealthDoc["state"]) : "Unknown";

  const props = (vm as { properties?: Record<string, any> } | null)?.properties ?? null;
  const iv = props?.instanceView ?? null;
  const agent = iv?.vmAgent;
  const vmAgent = agent && typeof agent === "object" ? { status: statusWith(agent.statuses, "ProvisioningState/") ?? null, version: str(agent.vmAgentVersion, 40) } : null;
  let bootDiagnostics: boolean | null = null;
  if (props) {
    const enabled = props.diagnosticsProfile?.bootDiagnostics?.enabled;
    bootDiagnostics = typeof enabled === "boolean" ? enabled : false;
  }

  return {
    state,
    title: str(ap.title, 200),
    summary: str(ap.summary, 1000),
    reason: str(ap.reasonType, 80),
    since: time(ap.occurredTime ?? ap.occuredTime),
    power: statusWith(iv?.statuses, "PowerState/"),
    provisioning: statusWith(iv?.statuses, "ProvisioningState/"),
    vmAgent,
    bootDiagnostics,
    checkedAt: now.toISOString(),
  };
}

export async function storeHealth(db: D1Database, doc: HealthDoc, now: Date): Promise<void> {
  await putLatest(db, "health", doc, now.toISOString());
}

const health: FeedModule = {
  id: "health",
  title: "Azure health",
  cadenceMin: 5,
  when: "rg",
  calls: 2,
  arm: true,
  async run(ctx) {
    const r = await fetchHealth(ctx);
    if (!r.vm) return { status: "ok", error: null }; // no VM (yet): nothing to say
    await storeHealth(ctx.db, normaliseHealth(r.availability, r.vm, ctx.now), ctx.now);
    return { status: "ok", error: null };
  },
};

export default health;
