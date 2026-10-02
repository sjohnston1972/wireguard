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
import { regionName, REGIONS } from "./region";

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

/**
 * Where a deploy goes: a profile (its region and size), a region on its
 * own, or the usual settings when neither is given. Throws RunError
 * "not_found" for a missing profile and "bad_input" for an unknown region.
 */
export async function resolveDeployTarget(env: Env, o: { profileId?: number | null; region?: string | null }): Promise<{ region?: string; vmSize?: string; profile: string | null }> {
  if (o.profileId !== undefined && o.profileId !== null) {
    const p = await db.getProfile(env, Number(o.profileId));
    if (!p) throw new RunError("No such profile.", "not_found");
    return { region: p.region, vmSize: p.vm_size, profile: p.name };
  }
  if (o.region !== undefined && o.region !== null) {
    // hasOwn, not "in": "in" would also accept built-in names like "constructor".
    if (!Object.hasOwn(REGIONS, o.region)) throw new RunError("Unknown region.", "bad_input");
    return { region: o.region, profile: null };
  }
  return { profile: null };
}

/**
 * Why a profile cannot be saved, in plain words, or null when it is fine.
 * The name is checked as given (the caller trims it).
 */
export function profileProblem(p: { name: string; region: string; vm_size: string }): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,23}$/.test(p.name)) return "The name must be 1 to 24 letters, numbers, spaces, dashes or underscores, starting with a letter or number.";
  if (!Object.hasOwn(REGIONS, p.region)) return "Unknown region.";
  if (!/^Standard_[A-Za-z0-9_]{1,30}$/.test(p.vm_size)) return "The VM size must look like Standard_B1s.";
  return null;
}
