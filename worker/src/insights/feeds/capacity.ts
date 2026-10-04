// insights/feeds/capacity.ts
//
// Plain English: "can the next deploy get this VM size here?". Two calls
// per region: Azure's list of VM sizes for the region (which ones are not
// offered to this subscription, and each size's vCPUs and family), and the
// subscription's vCPU usage and limits there. Read daily for each region in
// use (the configured one, then the profiles'), one region per run; the
// route reads another region on demand (insights/ondemand.ts).
//
// The size list is 1 to 3 MB, so skuRestrictions slices out only the wanted
// sizes before parsing anything (CPU on the Free plan is 10 ms).
//
// A deploy needs the size's vCPUs, plus 1 (B-series) when the test VM is on.
// Warnings only when the answer is no; the data can be a day old, so the
// deploy form says "may" and offers "Deploy anyway".

import type { FeedModule } from "../runner";
import type { CapacityDoc, FeedCtx } from "../types";
import type { CapacityCheck } from "../../../../shared/api";
import type { Config } from "../../env";
import { VM_SIZES } from "../../settings";
import { listProfiles } from "../../db";
import { azureRegionName } from "../../region";
import { DAY, HOUR, MIN, armRefusal, iso, num, paths, str } from "../common";

const SKU_API = "2021-07-01";
const USAGE_API = "2024-07-01";
/** The test VM's size and family (spec 4). */
export const TEST_VM_SIZE = "Standard_B1ls";
const TEST_VM_FAMILY = "standardBSFamily";
/** A region's reading is fresh for a day. */
export const CAPACITY_FRESH_MS = DAY;

/** The end of the JSON value starting at `start` (a "{"), skipping braces inside strings; -1 if it never closes. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (inString) {
      if (ch === 92) i++; // backslash: skip the escaped character
      else if (ch === 34) inString = false;
    } else if (ch === 34) inString = true;
    else if (ch === 123) depth++;
    else if (ch === 125 && --depth === 0) return i;
  }
  return -1;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The one SKU object for a VM size, sliced out of the reply and parsed on its own; undefined when the slicing could not find it. */
function sliceSku(text: string, name: string): Record<string, any> | null | undefined {
  const needle = new RegExp(`"name"\\s*:\\s*"${escapeRe(name)}"`, "g");
  let m: RegExpExecArray | null;
  let seen = false;
  while ((m = needle.exec(text))) {
    seen = true;
    const rt = text.lastIndexOf('"resourceType"', m.index);
    const start = rt < 0 ? -1 : text.lastIndexOf("{", rt);
    if (start < 0) continue;
    const end = objectEnd(text, start);
    if (end < 0 || end < m.index) continue;
    try {
      const o = JSON.parse(text.slice(start, end + 1)) as Record<string, any>;
      if (o?.resourceType === "virtualMachines" && o?.name === name) return o;
    } catch {
      /* not a whole object: keep looking */
    }
  }
  return seen ? undefined : null;
}

type SizeInfo = CapacityDoc["sizes"][number];

function sizeInfo(name: string, o: Record<string, any> | null): SizeInfo {
  if (!o) return { name, available: false, reason: "NotOffered", vcpus: null, family: null };
  const restrictions: any[] = Array.isArray(o.restrictions) ? o.restrictions : [];
  const loc = restrictions.find((r) => r?.type === "Location");
  const caps: any[] = Array.isArray(o.capabilities) ? o.capabilities : [];
  const vcpus = num(caps.find((c) => c?.name === "vCPUs")?.value);
  return { name, available: !loc, reason: loc ? str(loc.reasonCode, 60) ?? "Restricted" : null, vcpus, family: str(o.family, 60) };
}

/** Each wanted size's availability, vCPUs and family, from the raw SKU list text. */
export function skuRestrictions(text: string, sizes: string[]): SizeInfo[] {
  let whole: any[] | null = null;
  return sizes.map((name) => {
    const o = sliceSku(text, name);
    if (o !== undefined) return sizeInfo(name, o);
    // The size is named but slicing failed (Azure changed its layout): parse the whole list once, correct if slower.
    try {
      whole ??= ((JSON.parse(text) as { value?: any[] }).value ?? []) as any[];
    } catch {
      whole = [];
    }
    return sizeInfo(name, whole.find((x) => x?.resourceType === "virtualMachines" && x?.name === name) ?? null);
  });
}

/** The usages reply: the given vCPU families and the regional total ("cores"). */
export function normaliseUsages(reply: unknown, families: string[]): Pick<CapacityDoc, "usages" | "cores"> {
  const list = (reply as { value?: unknown })?.value;
  const rows = Array.isArray(list) ? list.slice(0, 500) : [];
  const read = (r: any) => ({ name: str(r?.name?.value, 80), used: num(r?.currentValue), limit: num(r?.limit) });
  const usages: CapacityDoc["usages"] = [];
  let cores: CapacityDoc["cores"] = null;
  for (const r of rows.map(read)) {
    if (!r.name || r.used === null || r.limit === null) continue;
    if (r.name === "cores") cores = { used: r.used, limit: r.limit };
    else if (families.includes(r.name)) usages.push({ family: r.name, used: r.used, limit: r.limit });
  }
  return { usages, cores };
}

/** "B-series" for standardBSFamily, "Basv2-series" for standardBasv2Family. */
function familyWords(family: string): string {
  if (family === "standardBSFamily") return "B-series";
  return `${family.replace(/^standard/i, "").replace(/Family$/i, "")}-series`;
}

function ageWords(fromIso: string | null, now: Date): string {
  const ms = now.getTime() - Date.parse(fromIso ?? "");
  if (!Number.isFinite(ms) || ms < MIN) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MIN)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`;
  const d = Math.floor(ms / DAY);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export function emptyCheck(region: string, size: string): CapacityCheck {
  return { region, size, available: null, reason: null, vcpusNeeded: null, family: null, total: null, ok: null, message: null, fetchedAt: null };
}

/** Can a deploy of `size` (plus the test VM) go to `region`, by this reading? With the spec 10.2 wording. */
export function capacityCheck(doc: CapacityDoc, region: string, size: string, testVm: boolean, fetchedAt: string | null, now: Date): CapacityCheck {
  const place = azureRegionName(region);
  const s = doc.sizes.find((x) => x.name === size);
  if (!s) return emptyCheck(region, size);
  const out: CapacityCheck = { ...emptyCheck(region, size), available: s.available, reason: s.reason, fetchedAt, total: doc.cores, vcpusNeeded: s.vcpus === null ? null : s.vcpus + (testVm ? 1 : 0) };
  if (!s.available) {
    out.ok = false;
    out.message = s.reason === "NotOffered" ? `${size} isn't offered in ${place}.` : `${size} isn't offered to this subscription in ${place} (${s.reason}).`;
    return out;
  }
  if (s.vcpus === null) return out; // offered; quota not judged
  const need = s.vcpus + (testVm ? 1 : 0);
  out.vcpusNeeded = need;
  const fam = s.family ? doc.usages.find((u) => u.family === s.family) ?? null : null;
  out.family = fam && s.family ? { name: s.family, used: fam.used, limit: fam.limit } : null;
  const famNeed = s.vcpus + (testVm && s.family === TEST_VM_FAMILY ? 1 : 0);
  const testFam = testVm && s.family !== TEST_VM_FAMILY ? doc.usages.find((u) => u.family === TEST_VM_FAMILY) ?? null : null;
  if (fam && fam.used + famNeed > fam.limit) {
    out.ok = false;
    out.message = `Needs ${famNeed} ${familyWords(fam.family)} vCPUs; ${fam.used} of ${fam.limit} used in ${place}.`;
  } else if (testFam && testFam.used + 1 > testFam.limit) {
    out.ok = false;
    out.message = `Needs 1 ${familyWords(TEST_VM_FAMILY)} vCPU for the test VM; ${testFam.used} of ${testFam.limit} used in ${place}.`;
  } else if (doc.cores && doc.cores.used + need > doc.cores.limit) {
    out.ok = false;
    out.message = `Needs ${need} vCPUs; ${doc.cores.used} of ${doc.cores.limit} used in ${place}.`;
  } else {
    out.ok = true;
    const q = fam ?? doc.cores;
    out.message = `Available${q ? ` · vCPU quota ${q.used} of ${q.limit} used` : ""} · checked ${ageWords(fetchedAt, now)}`;
  }
  return out;
}

/** The sizes worth recording for a region: every size on offer, the test VM's, the configured one, the profiles', and any asked for. */
export async function sizesOfInterest(ctx: Pick<FeedCtx, "env" | "cfg">, extra: string[] = []): Promise<string[]> {
  const profiles = await listProfiles(ctx.env).catch(() => []);
  return [...new Set([...VM_SIZES, TEST_VM_SIZE, ctx.cfg.vmSize, ...profiles.map((p) => p.vm_size), ...extra])];
}

/** Read one region (2 calls) and store it. */
export async function fetchCapacity(ctx: FeedCtx, region: string, sizes: string[]): Promise<CapacityDoc> {
  const sub = paths(ctx.env, ctx.cfg).sub;
  const s = await ctx.arm(`${sub}/providers/Microsoft.Compute/skus?api-version=${SKU_API}&$filter=${encodeURIComponent(`location eq '${region}'`)}`);
  if (!s.ok) throw await armRefusal(`the VM sizes for ${region}`, s);
  const found = skuRestrictions(await s.text(), sizes);
  const u = await ctx.arm(`${sub}/providers/Microsoft.Compute/locations/${encodeURIComponent(region)}/usages?api-version=${USAGE_API}`);
  if (!u.ok) throw await armRefusal(`the vCPU quota for ${region}`, u);
  const families = [...new Set([TEST_VM_FAMILY, ...found.map((x) => x.family).filter((f): f is string => !!f)])];
  return { sizes: found, ...normaliseUsages(await u.json(), families) };
}

export async function storeCapacity(db: D1Database, region: string, doc: CapacityDoc, at: string): Promise<void> {
  await db.prepare("INSERT INTO az_capacity (region, json, fetched_at) VALUES (?1, ?2, ?3) ON CONFLICT (region) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at").bind(region, JSON.stringify(doc), at).run();
}

/** A region's stored reading, or null. */
export async function readCapacity(db: D1Database, region: string): Promise<{ doc: CapacityDoc; fetchedAt: string } | null> {
  const r = await db.prepare("SELECT json, fetched_at FROM az_capacity WHERE region = ?1").bind(region).first<{ json: string; fetched_at: string }>();
  if (!r) return null;
  try {
    return { doc: JSON.parse(r.json) as CapacityDoc, fetchedAt: r.fetched_at };
  } catch {
    return null;
  }
}

/** Regions in use, the configured one first. */
export async function regionsInUse(ctx: Pick<FeedCtx, "env" | "cfg">): Promise<string[]> {
  const profiles = await listProfiles(ctx.env).catch(() => []);
  return [...new Set([ctx.cfg.region, ...profiles.map((p) => p.region)])];
}

/** The regions whose reading is missing or more than a day old. */
async function staleRegions(db: D1Database, regions: string[], now: Date): Promise<string[]> {
  const out: string[] = [];
  for (const r of regions) {
    const have = await db.prepare("SELECT fetched_at FROM az_capacity WHERE region = ?1").bind(r).first<{ fetched_at: string }>();
    if (!have || !(now.getTime() - Date.parse(have.fetched_at) < CAPACITY_FRESH_MS)) out.push(r);
  }
  return out;
}

export function capacityFromCfg(cfg: Config): { region: string; size: string; testVm: boolean } {
  return { region: cfg.region, size: cfg.vmSize, testVm: cfg.testVm };
}

const capacity: FeedModule = {
  id: "capacity",
  title: "Capacity and quota",
  cadenceMin: 1440,
  when: "always",
  calls: 2,
  arm: true,
  async run(ctx) {
    const stale = await staleRegions(ctx.db, await regionsInUse(ctx), ctx.now);
    if (!stale.length) return { status: "ok", error: null };
    const region = stale[0]!;
    const doc = await fetchCapacity(ctx, region, await sizesOfInterest(ctx));
    await storeCapacity(ctx.db, region, doc, ctx.now.toISOString());
    // More regions to read: come back next run, one region at a time.
    return { status: "ok", error: null, nextDueAt: stale.length > 1 ? iso(ctx.now.getTime() + 5 * MIN) : null };
  },
};

export default capacity;
