// devmarks.ts
//
// Plain English: the dev seeder's own markers. A few screens read seeded
// stand-ins on a developer's PC (Azure's data without Azure credentials, the
// backups list) instead of the real thing. Each stand-in is used only when
// the login bypass is on AND the seed route has left its marker in KV. Only
// /__dev/seed writes a marker, and that route is locked twice (the bypass and
// a localhost request: devseed.ts), so the bypass set on the live Worker by
// mistake (auth.ts ignores it there too) still shows nothing seeded.
// Demo mode's store (demo/store.ts) is the one other place: its environment
// is all seeded, its KV is its own, and only its seed writes the markers there.

import type { Env } from "./env";
import { isDemoEnv } from "./demo/env";

/** KV keys only the dev seed route writes (every seed wipes them first). */
export const DEVSEED_KV = {
  /** The insights or everything story left Azure feed rows: show them as connected. */
  insights: "devseed:insights",
  /** The everything story wrote its backups under DEVSEED_BACKUP_ROOT: list and serve those. */
  backups: "devseed:backups",
} as const;

/** Where the seeded backups live in the STATE bucket, apart from the real backups/ and config-backups/. */
export const DEVSEED_BACKUP_ROOT = "devseed/";

/**
 * Where seeded stand-ins may be shown at all (demo mode spec ruling 14): a
 * developer's PC (the login bypass exactly "1") or demo mode's own environment,
 * whose data is all seeded. Never the live Worker's real data. Nothing is ever
 * fetched on the strength of a stand-in.
 */
export function standInsAllowed(env: Env): boolean {
  return env.AUTH_DEV_BYPASS === "1" || isDemoEnv(env);
}

/** True only on a developer's PC, or in demo mode's store, after a seed that left this marker. */
export async function devSeeded(env: Env, key: (typeof DEVSEED_KV)[keyof typeof DEVSEED_KV]): Promise<boolean> {
  if (!standInsAllowed(env)) return false;
  try {
    return (await env.STATUS.get(key)) !== null;
  } catch {
    return false;
  }
}
