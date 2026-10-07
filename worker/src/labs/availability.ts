// labs/availability.ts
//
// Plain English: whether a lab can be deployed at all right now (labs spec
// §9.2 "Not available", no override): GitHub connected, the permissions the
// lab needs checked (Settings → Labs → Check permissions, KV
// labs:permissions), a free slot of the 32, and fewer live labs than
// labs_max_running. blockersOf lists every one of those that applies, in
// that order (labs redesign spec §6.1): the catalogue cards' readiness.

import type { Env } from "../env";
import { canDispatch } from "../env";
import * as db from "../db";
import { LAB_SLOTS, labNeeds, labsSettingsFrom, type LabDef } from "../../../shared/labs";
import type { LabBlocker, LabPermissions } from "../../../shared/api";
import { runningCount, slotsInUse } from "./store";

const NO_PERMISSIONS: LabPermissions = { checkedAt: null, role: null, users: null, groups: null, message: null };

/** The permission check's last result (KV labs:permissions). */
export async function permissions(env: Env): Promise<LabPermissions> {
  try {
    const v = await env.STATUS.get("labs:permissions");
    return v ? { ...NO_PERMISSIONS, ...(JSON.parse(v) as LabPermissions) } : NO_PERMISSIONS;
  } catch {
    return NO_PERMISSIONS;
  }
}

export interface Availability {
  permissions: LabPermissions;
  live: number;
  maxRunning: number;
  slotsUsed: number;
  github: boolean;
}

export async function availability(env: Env): Promise<Availability> {
  const [perm, live, stored, used] = await Promise.all([permissions(env), runningCount(env), db.allSettings(env), slotsInUse(env)]);
  return { permissions: perm, live, maxRunning: labsSettingsFrom(stored).labsMaxRunning, slotsUsed: used, github: canDispatch(env) };
}

/**
 * Every reason this lab cannot be deployed now from the availability alone (labs redesign spec
 * §6.1), in deployLab's order: GitHub, the governance role, Graph, a free slot, labs_max_running.
 * A permission never checked or failed (anything but true) is a blocker: fail-closed.
 */
export function blockersOf(def: LabDef, a: Availability): LabBlocker[] {
  const out: LabBlocker[] = [];
  if (!a.github) out.push({ kind: "github", message: "GitHub is not connected yet. Add GITHUB_TOKEN and GITHUB_REPO in Settings > Setup." });
  const needs = labNeeds(def);
  if (needs.role && a.permissions.role !== true) out.push({ kind: "role", message: "Needs the labs governance role: do the one-time setup, then Settings → Labs → Check permissions." });
  if (needs.graph && (a.permissions.users !== true || a.permissions.groups !== true)) out.push({ kind: "graph", message: "Needs the Microsoft Graph permissions for lab users and groups: do the one-time setup, then Settings → Labs → Check permissions." });
  if (a.slotsUsed >= LAB_SLOTS) out.push({ kind: "slots", message: `All ${LAB_SLOTS} address slots are in use. A slot is freed when a lab is clean in Azure again.` });
  if (a.live >= a.maxRunning) out.push({ kind: "max_running", message: `${a.maxRunning} labs are already running (the limit in Settings → Labs).` });
  return out;
}

/** Why this lab cannot be deployed now (no override), or null (spec §9.2 "Not available"): the first blocker's sentence. */
export function unavailableReason(def: LabDef, a: Availability): string | null {
  return blockersOf(def, a)[0]?.message ?? null;
}

/** deployLab's refusal when an earlier session left something in Azure (an ended_dirty session holding a slot, or an orphan entry). */
export const leftoversMessage = (def: Pick<LabDef, "title">): string => `${def.title} still has leftovers in Azure from an earlier session. Clean them up from the Labs tab first.`;
