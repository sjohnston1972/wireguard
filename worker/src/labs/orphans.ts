// labs/orphans.ts
//
// Plain English: the hourly orphan sweep (labs spec §7.5). Anything a lab
// left behind that nobody is watching: the sweep lists, in 7 calls,
// resource groups (rg-lab-*), Entra users and groups (lab-*), management
// groups, custom role definitions, and policy definitions and assignments
// (lab-*). A name counts only when it is a lab's (labIdOf: the longest
// catalogue id it fits, else the id it spells), is not owned by a live
// session of that lab, and has been there 30 minutes (Azure's creation time
// for groups, else when the sweep first saw it). Azure's own NetworkWatcherRG,
// the gateway's group and every other name are ignored.
//
// Each lab with leftovers gets one watchman note naming them (again only
// when the names change), and a row in KV labs:orphans for the Labs tab's
// Clean up button (a destroy run for that lab id). When every listing
// answered and a lab has nothing left, the slot its ended_dirty sessions
// still hold goes back to the pool.
//
// It only ever reads. Nothing here deletes anything; Clean up is a lab.yml
// destroy run, whose safety net only touches rg-lab-<id>* and lab-<id>-*.

import type { Env } from "../env";
import { canAzure } from "../env";
import * as db from "../db";
import { labDef } from "./catalogue";
import { labNeeds } from "../../../shared/labs";
import type { LabOrphan } from "../../../shared/api";
import { arm, graph, type Net } from "./net";
import { labIdOf } from "./cost";
import { freeSlot, LIVE_SQL } from "./store";

const MIN = 60_000;
export const SWEEP_EVERY_MS = 60 * MIN;
export const ORPHAN_GRACE_MS = 30 * MIN;
const KV_SWEEP = "labs:sweep";
const KV_ORPHANS = "labs:orphans";

interface SweepState {
  at: string;
  /** name -> when first seen (or Azure's creation time, if earlier). */
  seen: Record<string, string>;
  /** lab id -> the names its last note named (sorted, joined). */
  noted: Record<string, string>;
}

type Found = { name: string; created: string | null };

async function list<T>(r: Promise<Response>, what: string): Promise<T[]> {
  const res = await r;
  if (!res.ok) throw new Error(`${what} (${res.status})`);
  const j = (await res.json()) as { value?: T[] };
  return Array.isArray(j.value) ? j.value.slice(0, 1000) : [];
}

const starts = (s: unknown, p: string): s is string => typeof s === "string" && s.toLowerCase().startsWith(p);

/** The lab names in each listing, or null for a listing that failed. Exactly 7 calls (plus sign-ins). */
async function listAll(env: Env, net: Net): Promise<{ rg: Found[] | null; graph: Found[] | null; gov: Found[] | null; errors: string[] }> {
  const sub = `/subscriptions/${env.AZURE_SUBSCRIPTION_ID}`;
  const errors: string[] = [];
  const attempt = async <T>(fn: () => Promise<T[]>): Promise<T[] | null> => {
    try {
      return await fn();
    } catch (e) {
      errors.push((e as Error).message);
      return null;
    }
  };
  type Named = { name?: string; createdTime?: string; properties?: { displayName?: string; roleName?: string; createdTime?: string } };
  const rgs = await attempt(() => list<Named>(arm(env, net, `${sub}/resourcegroups?api-version=2021-04-01&$expand=createdTime`), "resource groups"));
  const startsLab = encodeURIComponent("startswith(displayName,'lab-') or startswith(userPrincipalName,'lab-')");
  const users = await attempt(() => list<{ displayName?: string; userPrincipalName?: string; createdDateTime?: string }>(graph(env, net, `/users?$filter=${startsLab}&$select=id,displayName,userPrincipalName,createdDateTime&$top=200`), "Entra users"));
  const groups = await attempt(() => list<{ displayName?: string; mailNickname?: string; createdDateTime?: string }>(graph(env, net, `/groups?$filter=${encodeURIComponent("startswith(displayName,'lab-')")}&$select=id,displayName,mailNickname,createdDateTime&$top=200`), "Entra groups"));
  const mgs = await attempt(() => list<Named>(arm(env, net, `/providers/Microsoft.Management/managementGroups?api-version=2021-04-01`), "management groups"));
  const roles = await attempt(() => list<Named>(arm(env, net, `${sub}/providers/Microsoft.Authorization/roleDefinitions?api-version=2022-04-01&$filter=${encodeURIComponent("type eq 'CustomRole'")}`), "custom roles"));
  const defs = await attempt(() => list<Named>(arm(env, net, `${sub}/providers/Microsoft.Authorization/policyDefinitions?api-version=2023-04-01&$filter=${encodeURIComponent("policyType eq 'Custom'")}`), "policy definitions"));
  const assigns = await attempt(() => list<Named>(arm(env, net, `${sub}/providers/Microsoft.Authorization/policyAssignments?api-version=2023-04-01`), "policy assignments"));

  const pick = (...names: unknown[]): string | null => (names.find((n) => starts(n, "lab-")) as string | undefined) ?? null;
  const rg = rgs?.filter((g) => starts(g.name, "rg-lab-")).map((g) => ({ name: g.name!, created: g.createdTime ?? g.properties?.createdTime ?? null })) ?? null;
  const entra =
    users && groups
      ? [...users.map((u) => ({ name: pick(u.displayName, u.userPrincipalName?.split("@")[0]), created: u.createdDateTime ?? null })), ...groups.map((g) => ({ name: pick(g.displayName, g.mailNickname), created: g.createdDateTime ?? null }))]
          .filter((x) => !!x.name)
          .map((x) => ({ name: x.name!, created: x.created }))
      : null;
  const gov =
    mgs && roles && defs && assigns
      ? [
          ...mgs.map((m) => pick(m.name, m.properties?.displayName)),
          ...roles.map((r) => pick(r.properties?.roleName)),
          ...defs.map((d) => pick(d.name, d.properties?.displayName)),
          ...assigns.map((a) => pick(a.name, a.properties?.displayName)),
        ]
          .filter((n): n is string => !!n)
          .map((name) => ({ name, created: null }))
      : null;
  return { rg, graph: entra, gov, errors };
}

async function readState(env: Env): Promise<SweepState | null> {
  try {
    const v = await env.STATUS.get(KV_SWEEP);
    return v ? (JSON.parse(v) as SweepState) : null;
  } catch {
    return null;
  }
}

/** The leftovers list the Labs tab shows (KV labs:orphans). */
export async function readOrphans(env: Env): Promise<LabOrphan[]> {
  try {
    const v = await env.STATUS.get(KV_ORPHANS);
    const o = v ? (JSON.parse(v) as LabOrphan[]) : [];
    return Array.isArray(o) ? o : [];
  } catch {
    return [];
  }
}

/** A lab is clean in Azure (a clean destroy said so): forget its leftovers and give back the slots its ended_dirty sessions held. */
export async function labIsClean(env: Env, labId: string): Promise<void> {
  const o = await readOrphans(env);
  if (o.some((x) => x.labId === labId)) await env.STATUS.put(KV_ORPHANS, JSON.stringify(o.filter((x) => x.labId !== labId)));
  await releaseDirtySlots(env, labId);
}

async function releaseDirtySlots(env: Env, labId: string): Promise<number> {
  const dirty = (await env.DB.prepare("SELECT id FROM lab_sessions WHERE lab_id = ?1 AND state = 'ended_dirty' AND slot IS NOT NULL").bind(labId).all<{ id: string }>()).results;
  for (const s of dirty) {
    await freeSlot(env, s.id);
    await env.DB.prepare("UPDATE lab_sessions SET slot = NULL, cidr = NULL WHERE id = ?1").bind(s.id).run();
  }
  return dirty.length;
}

/** One sweep, if an hour has passed since the last. Returns a log line, or null when not due. */
export async function sweepOrphans(env: Env, net: Net, now: Date): Promise<string | null> {
  if (!canAzure(env)) return null;
  const prev = await readState(env);
  if (prev && now.getTime() - Date.parse(prev.at) < SWEEP_EVERY_MS) return null;
  const t = now.getTime();
  const found = await listAll(env, net);

  const live = new Set((await env.DB.prepare(`SELECT DISTINCT lab_id FROM lab_sessions WHERE state IN (${LIVE_SQL})`).all<{ lab_id: string }>()).results.map((r) => r.lab_id));
  const seen: Record<string, string> = {};
  const byLab = new Map<string, { names: string[]; since: number }>();
  const present = new Set<string>(); // labs with any name at all, young or old
  for (const f of [...(found.rg ?? []), ...(found.graph ?? []), ...(found.gov ?? [])]) {
    const lab = labIdOf(f.name);
    if (!lab) continue; // not a lab's name
    present.add(lab);
    const first = Math.min(...[prev?.seen[f.name], f.created ?? undefined, now.toISOString()].map((x) => Date.parse(x ?? "")).filter(Number.isFinite));
    seen[f.name] = new Date(first).toISOString();
    if (live.has(lab)) continue; // a live session owns it
    if (t - first < ORPHAN_GRACE_MS) continue;
    const e = byLab.get(lab) ?? { names: [], since: first };
    e.names.push(f.name);
    e.since = Math.min(e.since, first);
    byLab.set(lab, e);
  }

  // Keep what a failed listing could not see as it was, rather than forgetting it.
  const before = await readOrphans(env);
  const orphans: LabOrphan[] = [...byLab].map(([labId, e]) => ({ labId, names: [...new Set(e.names)].sort(), since: new Date(e.since).toISOString() }));
  if (found.errors.length) for (const o of before) if (o.labId && !byLab.has(o.labId) && !live.has(o.labId)) orphans.push(o);
  orphans.sort((a, b) => (a.labId ?? "").localeCompare(b.labId ?? ""));
  await env.STATUS.put(KV_ORPHANS, JSON.stringify(orphans));

  // One note per lab, when its names change.
  const noted: Record<string, string> = { ...(prev?.noted ?? {}) };
  for (const o of orphans) {
    const key = o.names.join(",");
    if (!o.labId || noted[o.labId] === key) continue;
    noted[o.labId] = key;
    await db.addAlert(env, "cost_guard", `Lab leftovers: ${o.names.join(", ")}. Nothing is watching them; Clean up from the Labs tab.`);
  }
  for (const k of Object.keys(noted)) if (!orphans.some((o) => o.labId === k)) delete noted[k];

  // A clean sweep gives back the slots of ended_dirty sessions whose lab has nothing left.
  let released = 0;
  const dirty = (await env.DB.prepare("SELECT DISTINCT lab_id FROM lab_sessions WHERE state = 'ended_dirty' AND slot IS NOT NULL").all<{ lab_id: string }>()).results;
  for (const { lab_id } of dirty) {
    const def = labDef(lab_id);
    const needs = def ? labNeeds(def) : { role: true, graph: true };
    const sawAll = found.rg !== null && (found.graph !== null || !needs.graph) && (found.gov !== null || !needs.role);
    if (sawAll && !present.has(lab_id)) released += await releaseDirtySlots(env, lab_id);
  }

  const state: SweepState = { at: now.toISOString(), seen, noted };
  await env.STATUS.put(KV_SWEEP, JSON.stringify(state), { expirationTtl: 14 * 86_400 });
  const parts = [`orphans: ${orphans.length} lab(s) with leftovers`];
  if (released) parts.push(`${released} slot(s) released`);
  if (found.errors.length) parts.push(`could not list: ${found.errors.join("; ")}`);
  return parts.join(", ");
}
