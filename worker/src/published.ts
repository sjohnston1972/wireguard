// published.ts
//
// Plain English: keeping Azure's edge in step with the published ports. After
// any change to them, this opens or closes the matching ports on the VM's
// network security group, while there is a VM to open them for.

import type { Env } from "./env";
import * as db from "./db";
import { getSnapshot } from "./state";
import { effectiveConfig } from "./settings";
import { setPublishedPorts } from "./azure";
import { publishedNsgRules } from "./firewall";

/** Keep Azure's edge in step with the published ports, while there is a VM. Null when fine (or nothing to do), else Azure's reason. */
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
