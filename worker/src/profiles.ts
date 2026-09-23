// profiles.ts
//
// Plain English: named deploy presets ("UK", "US exit", "EU exit"): which
// Azure region and what size of VM. Deploy offers them as one tap each. While
// something is running, "Move to US exit" tears the current one down and
// builds the new one as soon as the tear-down finishes, so switching country
// is two taps. Clients do not change: they still dial wg.clydeford.net, which
// follows the VM to its new address.

import type { Env } from "./env";
import * as db from "./db";
import { getSnapshot, saveSnapshot } from "./state";
import { startDestroy, RunError } from "./runs";
import { regionName } from "./region";

/** Tear down what exists and queue a deploy of the chosen profile. */
export async function startMove(env: Env, o: { profileId: number; hours: number | null; by: string; requesterIp: string | null }): Promise<string> {
  const p = await db.getProfile(env, o.profileId);
  if (!p) throw new RunError("No such profile.");
  const snap = await getSnapshot(env);
  if (snap.state !== "running" && snap.state !== "standby") throw new RunError("Nothing to move: deploy instead.");
  if ((snap.region ?? "") === p.region && (snap.vm_size ?? "") === p.vm_size) throw new RunError(`Already running as ${p.name}.`);
  const run = await startDestroy(env, o.by, `move to ${p.name}`);
  await saveSnapshot(env, { pending_deploy: { region: p.region, vm_size: p.vm_size, profile: p.name, hours: o.hours, requested_by: o.by, requester_ip: o.requesterIp } });
  return `Moving to ${p.name} (${regionName(p.region)}): tearing down now (${run.id}), then building there. About 6 minutes in all.`;
}
