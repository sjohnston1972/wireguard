// devmarks.ts
//
// Plain English: the dev seeder's own markers. A few screens read seeded
// stand-ins on a developer's PC (Azure's data without Azure credentials, the
// backups list) instead of the real thing. Each stand-in is used only when
// the login bypass is on AND the seed route has left its marker in KV. Only
// /__dev/seed writes a marker, and that route is locked twice (the bypass and
// a localhost request: devseed.ts), so the bypass set on the live Worker by
// mistake (auth.ts ignores it there too) still shows nothing seeded.

import type { Env } from "./env";

/** KV keys only the dev seed route writes (every seed wipes them first). */
export const DEVSEED_KV = {
  /** The insights or everything story left Azure feed rows: show them as connected. */
  insights: "devseed:insights",
  /** The everything story wrote its backups under DEVSEED_BACKUP_ROOT: list and serve those. */
  backups: "devseed:backups",
} as const;

/** Where the seeded backups live in the STATE bucket, apart from the real backups/ and config-backups/. */
export const DEVSEED_BACKUP_ROOT = "devseed/";

/** True only on a developer's PC after a seed that left this marker. */
export async function devSeeded(env: Env, key: (typeof DEVSEED_KV)[keyof typeof DEVSEED_KV]): Promise<boolean> {
  if (env.AUTH_DEV_BYPASS !== "1") return false;
  try {
    return (await env.STATUS.get(key)) !== null;
  } catch {
    return false;
  }
}
