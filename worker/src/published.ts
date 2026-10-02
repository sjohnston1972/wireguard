// published.ts
//
// Plain English: keep Azure's edge in step with the published ports, while
// there is a VM (running or in Standby). Returns null when it worked, or
// Azure's reason when it did not. Shared by the pages and the data API.

import type { Env } from "./env";
import * as db from "./db";
import { getSnapshot } from "./state";
import { effectiveConfig } from "./settings";
import { setPublishedPorts } from "./azure";
import { publishedNsgRules } from "./firewall";

/** Keep Azure's edge in step with the published ports, while there is a VM. */
export async function syncPublished(env: Env): Promise<string | null> {
  const snap = await getSnapshot(env);
  if (snap.state !== "running" && snap.state !== "standby") return null;
  try {
    await setPublishedPorts(env, publishedNsgRules(await db.listForwards(env), await effectiveConfig(env)));
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
