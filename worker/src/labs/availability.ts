// labs/availability.ts
//
// Plain English: whether a lab can be deployed at all right now (labs spec
// §9.2 "Not available", no override): GitHub connected, the permissions the
// lab needs checked (Settings → Labs → Check permissions, KV
// labs:permissions), a free slot of the 32, and fewer live labs than
// labs_max_running.

import type { Env } from "../env";
import { canDispatch } from "../env";
import * as db from "../db";
import { LAB_SLOTS, labNeeds, labsSettingsFrom, type LabDef } from "../../../shared/labs";
import type { LabPermissions } from "../../../shared/api";
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

/** Why this lab cannot be deployed now (no override), or null (spec §9.2 "Not available"). */
export function unavailableReason(def: LabDef, a: Availability): string | null {
  if (!a.github) return "GitHub is not connected yet. Add GITHUB_TOKEN and GITHUB_REPO in Settings > Setup.";
  const needs = labNeeds(def);
  if (needs.role && a.permissions.role !== true) return "Needs the labs governance role: do the one-time setup, then Settings → Labs → Check permissions.";
  if (needs.graph && (a.permissions.users !== true || a.permissions.groups !== true)) return "Needs the Microsoft Graph permissions for lab users and groups: do the one-time setup, then Settings → Labs → Check permissions.";
  if (a.slotsUsed >= LAB_SLOTS) return `All ${LAB_SLOTS} address slots are in use. A slot is freed when a lab is clean in Azure again.`;
  if (a.live >= a.maxRunning) return `${a.maxRunning} labs are already running (the limit in Settings → Labs).`;
  return null;
}
