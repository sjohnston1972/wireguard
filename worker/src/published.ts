// published.ts
//
// Plain English: keeping the cloud's edge in step with the published ports.
// After any change to them, this opens or closes the matching ports on the
// VM's edge firewall (Azure's network security group, AWS's security group),
// while there is a VM to open them for.

import type { Env } from "./env";
import * as db from "./db";
import { cloudOf, getSnapshot } from "./state";
import { effectiveConfig } from "./settings";
import { publishedNsgRules } from "./firewall";
import { opsFor } from "./cloud";

/**
 * Keep the headend cloud's edge in step with the published ports, while there is a VM. Null when fine (or nothing
 * to do), else which cloud refused ("Azure", "AWS") and its reason.
 */
export async function syncPublished(env: Env): Promise<{ cloud: string; reason: string } | null> {
  const snap = await getSnapshot(env);
  if (snap.state !== "running" && snap.state !== "standby") return null;
  const ops = opsFor(cloudOf(snap));
  try {
    await ops.setPublishedPorts(env, publishedNsgRules(await db.listForwards(env), await effectiveConfig(env)));
    return null;
  } catch (e) {
    return { cloud: ops.label, reason: (e as Error).message };
  }
}
