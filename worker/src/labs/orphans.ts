// labs/orphans.ts
//
// Plain English: the hourly orphan sweep (labs spec §7.5). Anything a lab
// left behind that nobody is watching: the sweep lists, in SWEEP_CALLS calls,
// resource groups (rg-lab-*), Entra users (user principal name lab-*) and groups (display name lab-*, the fields the safety net deletes by), management
// groups, custom role definitions, and policy definitions and assignments
// (lab-*; an assignment also by its display name or its scope), and VNet flow
// logs named lab-* (AZ-700 scope exception S2: lab 44's lives on Azure's own
// NetworkWatcher_<region> in NetworkWatcherRG, outside every lab group). A name
// counts only when it is a lab's (labIdOf: the longest
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
//
// An AWS sweep beside the Azure one (AWS labs spec §6, §8.4, rulings A16 and
// P7): its own hourly step (KV labs:sweep-aws), because the watch's calls
// cannot hold both sweeps in one run. In AWS_SWEEP_CALLS calls it lists what
// is tagged cloudlabs-lab in the four regions labs touch, the IAM roles,
// instance profiles, customer policies and users under /cloudlabs-lab/, and
// the Config recorders and lab-* dashboards of both lab regions. A tagged
// item's lab is its tag's value; a name's, labIdOf. The tagging API keeps
// listing deleted items for about an hour, so an AWS item counts only once
// no live session of its lab has seen it for 90 minutes. It can keep listing
// them for many hours more (live 2026-10-16: terminated instances, deleted
// VPC endpoints, INACTIVE ECS clusters and services), so an EC2 instance or
// VPC endpoint in a lab region counts only once EC2 confirms it still exists
// (one Describe per region and kind, AWS_CONFIRM_CALLS at most; a read that
// fails keeps it counted), and ECS clusters, services and task definitions,
// which the Worker cannot describe, are never counted. Each sweep rewrites
// only its own cloud's entries in labs:orphans and gives back only its own
// cloud's ended_dirty slots; Clean up for an AWS lab is a lab-aws.yml destroy.

import type { Env } from "../env";
import { canAws, canAzure } from "../env";
import * as db from "../db";
import { labDef } from "./catalogue";
import { ALLOWED_ROLES, AWS_GLOBAL_REGIONS, AWS_LAB_REGIONS, FLOW_LOG_LABS, LAB_ID_MAX, LAB_ID_RE, LAB_TAG, cloudOfId, labNeeds, type LabCloud } from "../../../shared/labs";
import type { LabOrphan } from "../../../shared/api";
import { arm, graph, BudgetExceeded, type Net } from "./net";
import { labIdOf } from "./cost";
import { freeSlot, LIVE_SQL } from "./store";
import { AwsError } from "../cloud/awsApi";
import { arnParts, configRecorderNames, dashboardNames, ec2Gone, iamLabNames, labTagged, taggedName, type Ec2ConfirmKind } from "./awsReads";

const MIN = 60_000;
export const SWEEP_EVERY_MS = 60 * MIN;
export const ORPHAN_GRACE_MS = 30 * MIN;
/**
 * The sweep's calls: eight listings (resource groups, Entra users and groups, management
 * groups, custom roles, policy definitions and assignments, and flow logs) plus one GET per
 * fixed custom role GUID in labs/setup/allowed-roles.json: the subscription's role list
 * leaves out a role assignable only inside a resource group (lab 1's), so each is asked for
 * directly.
 */
export const SWEEP_CALLS = 8 + ALLOWED_ROLES.custom.length;
const KV_SWEEP = "labs:sweep";
const KV_ORPHANS = "labs:orphans";
/** The AWS sweep's calls: tagging in four regions, four IAM listings, recorders and dashboards in both lab regions. */
export const AWS_SWEEP_CALLS = 12;
/** At most one confirm read per lab region and EC2 kind (instances, VPC endpoints), reserved before the sweep starts. */
export const AWS_CONFIRM_CALLS = AWS_LAB_REGIONS.length * 2;
/** How long an AWS item must go unseen by a live session of its lab before it counts (A16). */
export const AWS_ORPHAN_GRACE_MS = 90 * MIN;
const KV_SWEEP_AWS = "labs:sweep-aws";

interface SweepState {
  at: string;
  /** name -> when first seen (or Azure's creation time, if earlier). */
  seen: Record<string, string>;
  /** lab id -> the names its last note named (sorted, joined). */
  noted: Record<string, string>;
}

/** One name a listing returned; `lab` when the name alone cannot tell (a policy assignment known by its scope). */
type Found = { name: string; created: string | null; lab?: string | null; arn?: string };

async function list<T>(r: Promise<Response>, what: string): Promise<T[]> {
  const res = await r;
  if (!res.ok) throw new Error(`${what} (${res.status})`);
  const j = (await res.json()) as { value?: T[] };
  return Array.isArray(j.value) ? j.value.slice(0, 1000) : [];
}

const starts = (s: unknown, p: string): s is string => typeof s === "string" && s.toLowerCase().startsWith(p);

/** The lab names in each listing, or null for a listing that failed. Exactly SWEEP_CALLS calls (plus sign-ins). */
async function listAll(env: Env, net: Net): Promise<{ rg: Found[] | null; graph: Found[] | null; gov: Found[] | null; flow: Found[] | null; errors: string[] }> {
  const sub = `/subscriptions/${env.AZURE_SUBSCRIPTION_ID}`;
  const errors: string[] = [];
  const attempt = async <T>(fn: () => Promise<T[]>): Promise<T[] | null> => {
    try {
      return await fn();
    } catch (e) {
      // Out of calls is not "Azure could not answer": the whole sweep waits for the next run.
      if (e instanceof BudgetExceeded) throw e;
      errors.push((e as Error).message);
      return null;
    }
  };
  type Named = { name?: string; createdTime?: string; properties?: { displayName?: string; roleName?: string; createdTime?: string; scope?: string } };
  const rgs = await attempt(() => list<Named>(arm(env, net, `${sub}/resourcegroups?api-version=2021-04-01&$expand=createdTime`), "resource groups"));
  // Entra names are matched by the field the safety net deletes by (lab-safety-net.sh): users by
  // user principal name, groups by display name. A look-alike in another field is never deleted
  // by a Clean up, so it must not become a leftover note that can never clear.
  const users = await attempt(() => list<{ userPrincipalName?: string; createdDateTime?: string }>(graph(env, net, `/users?$filter=${encodeURIComponent("startswith(userPrincipalName,'lab-')")}&$select=id,userPrincipalName,createdDateTime&$top=200`), "Entra users"));
  const groups = await attempt(() => list<{ displayName?: string; createdDateTime?: string }>(graph(env, net, `/groups?$filter=${encodeURIComponent("startswith(displayName,'lab-')")}&$select=id,displayName,createdDateTime&$top=200`), "Entra groups"));
  // wg-admin's identity owns every management group it creates, so when Azure refuses the
  // list outright (403 AuthorizationFailed, e.g. a tenant that has never used management
  // groups) none of the labs' exist: that is "none", not "could not list" (live 2026-10-05).
  const mgs = await attempt(async () => {
    const res = await arm(env, net, `/providers/Microsoft.Management/managementGroups?api-version=2021-04-01`);
    if (res.status === 403) {
      const body = await res.text();
      if (body.includes("AuthorizationFailed")) return [] as Named[];
      throw new Error("management groups (403)");
    }
    return list<Named>(Promise.resolve(res), "management groups");
  });
  const roles = await attempt(() => list<Named>(arm(env, net, `${sub}/providers/Microsoft.Authorization/roleDefinitions?api-version=2022-04-01&$filter=${encodeURIComponent("type eq 'CustomRole'")}`), "custom roles"));
  const defs = await attempt(() => list<Named>(arm(env, net, `${sub}/providers/Microsoft.Authorization/policyDefinitions?api-version=2023-04-01&$filter=${encodeURIComponent("policyType eq 'Custom'")}`), "policy definitions"));
  const assigns = await attempt(() => list<Named>(arm(env, net, `${sub}/providers/Microsoft.Authorization/policyAssignments?api-version=2023-04-01`), "policy assignments"));
  // Each lab's fixed custom role GUID, directly: 404 means it is gone.
  const fixed = await attempt(async () => {
    const out: Named[] = [];
    for (const c of ALLOWED_ROLES.custom) {
      const res = await arm(env, net, `${sub}/providers/Microsoft.Authorization/roleDefinitions/${c.id}?api-version=2022-04-01`);
      if (res.status === 404) continue;
      if (!res.ok) throw new Error(`custom role ${c.name} (${res.status})`);
      out.push((await res.json()) as Named);
    }
    return out;
  });

  // VNet flow logs (S2): ARM lists the nested type across the subscription in one call, every region's watcher at
  // once. Only a flow log named lab-<id>-* is a lab's (the name the safety net deletes by); its group is Azure's own.
  const flowLogs = await attempt(() => list<{ id?: string; createdTime?: string }>(arm(env, net, `${sub}/resources?api-version=2021-04-01&$filter=${encodeURIComponent("resourceType eq 'Microsoft.Network/networkWatchers/flowLogs'")}&$expand=createdTime`), "flow logs"));

  const pick = (...names: unknown[]): string | null => (names.find((n) => starts(n, "lab-")) as string | undefined) ?? null;
  const rg = rgs?.filter((g) => starts(g.name, "rg-lab-")).map((g) => ({ name: g.name!, created: g.createdTime ?? g.properties?.createdTime ?? null })) ?? null;
  const entra =
    users && groups
      ? [...users.map((u) => ({ name: pick(u.userPrincipalName?.split("@")[0]), created: u.createdDateTime ?? null })), ...groups.map((g) => ({ name: pick(g.displayName), created: g.createdDateTime ?? null }))]
          .filter((x) => !!x.name)
          .map((x) => ({ name: x.name!, created: x.created }))
      : null;
  const gov =
    mgs && roles && fixed && defs && assigns
      ? [
          ...mgs.map((m) => pick(m.name, m.properties?.displayName)),
          ...[...roles, ...fixed.filter((f) => !roles.some((r) => r.name === f.name))].map((r) => pick(r.properties?.roleName)),
          ...defs.map((d) => pick(d.name, d.properties?.displayName)),
        ]
          .filter((n): n is string => !!n)
          .map((name): Found => ({ name, created: null }))
          .concat(assigns.map(assignmentFound).filter((f): f is Found => f !== null))
      : null;
  const flow =
    flowLogs
      ?.map((f) => ({ name: (f.id ?? "").split("/").pop() ?? "", created: f.createdTime ?? null }))
      .filter((f) => starts(f.name, "lab-"))
      .map((f): Found => ({ name: `${f.name} (flow log)`, created: f.created, lab: labIdOf(f.name) })) ?? null;
  return { rg, graph: entra, gov, flow, errors };
}

/**
 * A policy assignment is a lab's by its name or display name (lab-<id>-...),
 * or by its scope: inside rg-lab-<id> or a lab-<id>-* management group.
 * Assignment names are capped at 24 characters, so a lab may name one
 * plainly (lab 3's audit-environment-tag) and carry its prefix only in the
 * display name or its scope. Anything else (the organisation's own) is not.
 */
export function assignmentFound(a: { name?: string; properties?: { displayName?: string; scope?: string } }): Found | null {
  const named = [a.name, a.properties?.displayName].find((n) => starts(n, "lab-"));
  if (named) return { name: named, created: null };
  const scope = (a.properties?.scope ?? "").split("/");
  const at = scope.findIndex((x) => /^(resourcegroups|managementgroups)$/i.test(x));
  const holder = at >= 0 ? scope[at + 1] ?? "" : "";
  if (!starts(holder, "rg-lab-") && !starts(holder, "lab-")) return null;
  const lab = labIdOf(holder);
  return lab && a.name ? { name: `${a.name} (${holder})`, created: null, lab } : null;
}

async function readState(env: Env, key = KV_SWEEP): Promise<SweepState | null> {
  try {
    const v = await env.STATUS.get(key);
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

/** Which cloud a leftovers entry belongs to: its lab id's (an entry with no id is Azure's, as before AWS). */
const cloudOfEntry = (o: LabOrphan): LabCloud => (o.labId ? cloudOfId(o.labId) : "azure");

/**
 * Write one sweep's leftovers into KV labs:orphans: the other cloud's entries as they are, plus this cloud's fresh
 * list. When a listing failed (`partial`), this cloud's earlier entries it could not see again are kept as they
 * were (unless a live session owns the lab now), rather than forgotten. Returns this cloud's entries.
 */
async function saveOrphans(env: Env, cloud: LabCloud, byLab: Map<string, { names: string[]; since: number }>, live: Set<string>, partial: boolean): Promise<LabOrphan[]> {
  const before = await readOrphans(env);
  const mine: LabOrphan[] = [...byLab].map(([labId, e]) => ({ labId, names: [...new Set(e.names)].sort(), since: new Date(e.since).toISOString() }));
  if (partial) for (const o of before) if (o.labId && cloudOfEntry(o) === cloud && !byLab.has(o.labId) && !live.has(o.labId)) mine.push(o);
  const others = before.filter((o) => cloudOfEntry(o) !== cloud);
  const byId = (a: LabOrphan, b: LabOrphan) => (a.labId ?? "").localeCompare(b.labId ?? "");
  mine.sort(byId);
  await env.STATUS.put(KV_ORPHANS, JSON.stringify([...others, ...mine].sort(byId)));
  return mine;
}

/** One watchman note per lab, when its names change. Returns the sweep's `noted` (this cloud's labs only). */
async function noteOrphans(env: Env, orphans: LabOrphan[], prev: SweepState | null): Promise<Record<string, string>> {
  const noted: Record<string, string> = { ...(prev?.noted ?? {}) };
  for (const o of orphans) {
    const key = o.names.join(",");
    if (!o.labId || noted[o.labId] === key) continue;
    noted[o.labId] = key;
    await db.addAlert(env, "cost_guard", `Lab leftovers: ${o.names.join(", ")}. Nothing is watching them; Clean up from the Labs tab.`);
  }
  for (const k of Object.keys(noted)) if (!orphans.some((o) => o.labId === k)) delete noted[k];
  return noted;
}

/** The labs of one cloud with ended_dirty sessions still holding a slot. */
async function dirtyLabs(env: Env, cloud: LabCloud): Promise<string[]> {
  const dirty = (await env.DB.prepare("SELECT DISTINCT lab_id FROM lab_sessions WHERE state = 'ended_dirty' AND slot IS NOT NULL").all<{ lab_id: string }>()).results;
  return dirty.map((d) => d.lab_id).filter((id) => cloudOfId(id) === cloud);
}

/** One sweep, if an hour has passed since the last. Returns a log line, or null when not due. */
export async function sweepOrphans(env: Env, net: Net, now: Date): Promise<string | null> {
  if (!canAzure(env)) return null;
  const prev = await readState(env);
  if (prev && now.getTime() - Date.parse(prev.at) < SWEEP_EVERY_MS) return null;
  // Its eight listings and the fixed roles, or none: a half sweep is never recorded, so it stays due.
  if (net.remaining() < SWEEP_CALLS) throw new BudgetExceeded(SWEEP_CALLS, net.remaining(), SWEEP_CALLS);
  const t = now.getTime();
  const found = await listAll(env, net);

  const live = new Set((await env.DB.prepare(`SELECT DISTINCT lab_id FROM lab_sessions WHERE state IN (${LIVE_SQL})`).all<{ lab_id: string }>()).results.map((r) => r.lab_id));
  const seen: Record<string, string> = {};
  const byLab = new Map<string, { names: string[]; since: number }>();
  const present = new Set<string>(); // labs with any name at all, young or old
  for (const f of [...(found.rg ?? []), ...(found.graph ?? []), ...(found.gov ?? []), ...(found.flow ?? [])]) {
    const lab = f.lab ?? labIdOf(f.name);
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

  const orphans = await saveOrphans(env, "azure", byLab, live, found.errors.length > 0);
  const noted = await noteOrphans(env, orphans, prev);

  // A clean sweep gives back the slots of ended_dirty sessions whose lab has nothing left (Azure labs only: the
  // AWS sweep gives back its own).
  let released = 0;
  for (const lab_id of await dirtyLabs(env, "azure")) {
    const def = labDef(lab_id);
    const needs = def ? labNeeds(def) : { role: true, graph: true };
    const sawAll = found.rg !== null && (found.graph !== null || !needs.graph) && (found.gov !== null || !needs.role) && (found.flow !== null || !FLOW_LOG_LABS.includes(lab_id));
    if (sawAll && !present.has(lab_id)) released += await releaseDirtySlots(env, lab_id);
  }

  const state: SweepState = { at: now.toISOString(), seen, noted };
  await env.STATUS.put(KV_SWEEP, JSON.stringify(state), { expirationTtl: 14 * 86_400 });
  const parts = [`orphans: ${orphans.length} lab(s) with leftovers`];
  if (released) parts.push(`${released} slot(s) released`);
  if (found.errors.length) parts.push(`could not list: ${found.errors.join("; ")}`);
  return parts.join(", ");
}

// ── AWS (AWS labs spec §6, §8.4) ─────────────────────────────────────────

/** An AWS lab id, or null: a lab's tag value or a name's lab must be a valid id of an AWS exam. */
const awsLabId = (id: string | null | undefined): string | null => (id && id.length <= LAB_ID_MAX && LAB_ID_RE.test(id) && cloudOfId(id) === "aws" ? id : null);

/** Ruling P11: a lab's KMS key waits 7 days to delete (no charge) and the tagging API lists it all week: never an orphan. */
const KMS_KEY = /^arn:aws[a-z-]*:kms:[^:]*:[0-9]*:key\//;
/**
 * The tagging API lists an ECS cluster or service for hours after it is INACTIVE, and a deregistered task definition
 * while it is INACTIVE or DELETE_IN_PROGRESS (live 2026-10-16). The Worker's IAM user has no ecs:Describe*, so these
 * are never orphans: a real ECS leftover still runs in the lab's own VPC and subnets, which are counted.
 */
const ECS_GHOSTS = /^arn:aws[a-z-]*:ecs:[^:]*:[0-9]*:(cluster|service|task-definition)\//;
const AWS_SWEEP_SKIP = (arn: string) => KMS_KEY.test(arn) || ECS_GHOSTS.test(arn);

/**
 * Of the AWS sweep's would-be orphans, the ARNs EC2 says are really gone: the instances and VPC endpoints in a lab
 * region (the Worker's IAM user may describe only there), one read per region and kind. A read that fails (refused,
 * throttled, out of calls) clears nothing: those items stay counted.
 */
async function confirmGone(env: Env, net: Net, candidates: Found[]): Promise<Set<string>> {
  const groups = new Map<string, { region: string; kind: Ec2ConfirmKind; byId: Map<string, string> }>();
  for (const f of candidates) {
    if (!f.arn) continue;
    const region = f.arn.split(":")[3] ?? "";
    const p = arnParts(f.arn);
    if (p.service !== "ec2" || (p.type !== "instance" && p.type !== "vpc-endpoint") || !(AWS_LAB_REGIONS as readonly string[]).includes(region)) continue;
    const key = `${region} ${p.type}`;
    const g = groups.get(key) ?? { region, kind: p.type, byId: new Map<string, string>() };
    g.byId.set(p.id, f.arn);
    groups.set(key, g);
  }
  const gone = new Set<string>();
  for (const g of groups.values()) {
    try {
      for (const id of await ec2Gone(env, net, g.region, g.kind, [...g.byId.keys()])) gone.add(g.byId.get(id)!);
    } catch {
      /* not confirmed: counted, as before */
    }
  }
  return gone;
}

/** The 12 AWS listings, in order; a listing that failed is left out and named in `errors`. */
async function listAws(env: Env, net: Net): Promise<{ found: Found[]; errors: string[] }> {
  const found: Found[] = [];
  const errors: string[] = [];
  const attempt = async (what: string, fn: () => Promise<Found[]>) => {
    try {
      found.push(...(await fn()));
    } catch (e) {
      // Out of calls is not "AWS could not answer": the whole sweep waits for the next run.
      if (e instanceof BudgetExceeded) throw e;
      errors.push(`${what} (${e instanceof AwsError ? e.code : (e as Error).message})`);
    }
  };
  const named = (names: string[], word: string): Found[] => names.map((n) => ({ name: `${word} ${n}`, created: null, lab: awsLabId(labIdOf(n)) }));
  for (const region of [...AWS_LAB_REGIONS, ...AWS_GLOBAL_REGIONS]) {
    await attempt(`tagged resources in ${region}`, async () => {
      const page = await labTagged(env, net, region);
      // One page only: what it holds counts, but a listing with more is partial (no slot is released on it and
      // earlier entries it may not have seen are kept), never "complete".
      if (page.truncated) errors.push(`tagged resources in ${region} (more than ${page.length})`);
      return page.filter((t) => !AWS_SWEEP_SKIP(t.arn)).map((t) => ({ name: taggedName(t.arn), created: null, lab: awsLabId(t.tags[LAB_TAG]), arn: t.arn }));
    });
  }
  await attempt("IAM roles", async () => named(await iamLabNames(env, net, "roles"), "iam role"));
  await attempt("IAM instance profiles", async () => named(await iamLabNames(env, net, "instance-profiles"), "iam instance profile"));
  await attempt("IAM policies", async () => named(await iamLabNames(env, net, "policies"), "iam policy"));
  await attempt("IAM users", async () => named(await iamLabNames(env, net, "users"), "iam user"));
  for (const region of AWS_LAB_REGIONS) {
    await attempt(`Config recorders in ${region}`, async () => named(await configRecorderNames(env, net, region), "config recorder"));
    await attempt(`dashboards in ${region}`, async () => named(await dashboardNames(env, net, region), "dashboard"));
  }
  return { found, errors };
}

/**
 * One AWS sweep, if an hour has passed since the last (KV labs:sweep-aws) and the Worker has AWS keys. Returns a log
 * line, or null when not due. Needs AWS_SWEEP_CALLS + AWS_CONFIRM_CALLS calls left or makes none (BudgetExceeded): a half sweep is never
 * recorded, so it stays due for the next run.
 */
export async function sweepAwsOrphans(env: Env, net: Net, now: Date): Promise<string | null> {
  if (!canAws(env)) return null;
  const prev = await readState(env, KV_SWEEP_AWS);
  if (prev && now.getTime() - Date.parse(prev.at) < SWEEP_EVERY_MS) return null;
  // The listings and the confirm reads, or none.
  const need = AWS_SWEEP_CALLS + AWS_CONFIRM_CALLS;
  if (net.remaining() < need) throw new BudgetExceeded(need, net.remaining(), need);
  const t = now.getTime();
  const { found, errors } = await listAws(env, net);

  const live = new Set((await env.DB.prepare(`SELECT DISTINCT lab_id FROM lab_sessions WHERE state IN (${LIVE_SQL})`).all<{ lab_id: string }>()).results.map((r) => r.lab_id));
  const seen: Record<string, string> = {};
  const rows: { f: Found; lab: string; first: number | null }[] = [];
  for (const f of found) {
    const lab = f.lab;
    if (!lab) continue; // not a lab's (or not an AWS lab's)
    // The 90 minutes run from the last sweep a live session of the lab saw it: the tagging API lists a deleted item
    // for about an hour, so what a clean tear-down removed is never named.
    if (live.has(lab)) {
      seen[f.name] = now.toISOString();
      rows.push({ f, lab, first: null });
      continue;
    }
    const first = Math.min(...[prev?.seen[f.name], now.toISOString()].map((x) => Date.parse(x ?? "")).filter(Number.isFinite));
    seen[f.name] = new Date(first).toISOString();
    rows.push({ f, lab, first: t - first < AWS_ORPHAN_GRACE_MS ? null : first });
  }
  // A would-be orphan EC2 says is gone (it can stay listed for hours) is neither a leftover nor keeps its lab present.
  const gone = await confirmGone(env, net, rows.filter((r) => r.first !== null).map((r) => r.f));
  const byLab = new Map<string, { names: string[]; since: number }>();
  const present = new Set<string>();
  for (const { f, lab, first } of rows) {
    if (f.arn && gone.has(f.arn)) continue;
    present.add(lab);
    if (first === null) continue; // a live session owns it, or it is inside the 90 minutes
    const e = byLab.get(lab) ?? { names: [], since: first };
    e.names.push(f.name);
    e.since = Math.min(e.since, first);
    byLab.set(lab, e);
  }

  const orphans = await saveOrphans(env, "aws", byLab, live, errors.length > 0);
  const noted = await noteOrphans(env, orphans, prev);

  // A sweep that saw every listing gives back the slots of ended_dirty AWS sessions whose lab has nothing left.
  let released = 0;
  if (!errors.length) for (const lab_id of await dirtyLabs(env, "aws")) if (!present.has(lab_id)) released += await releaseDirtySlots(env, lab_id);

  const state: SweepState = { at: now.toISOString(), seen, noted };
  await env.STATUS.put(KV_SWEEP_AWS, JSON.stringify(state), { expirationTtl: 14 * 86_400 });
  const parts = [`aws orphans: ${orphans.length} lab(s) with leftovers`];
  if (released) parts.push(`${released} slot(s) released`);
  if (errors.length) parts.push(`could not list: ${errors.join("; ")}`);
  return parts.join(", ");
}
