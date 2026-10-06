// shared/topology/keys.ts
//
// Plain English: a node's key (lab topology spec ruling 6) is what stays the
// same between a lab's planned diagram and its live one, and between two
// sessions of the same lab, so saved positions and the planned/live
// comparison can find "the same" resource: "<arm type>/<name path>", lower
// case, with the session's random name prefix replaced by {p}, its region by
// {r} and its secondary region by {r2}. A child's path includes its parent's
// (a subnet: "microsoft.network/virtualnetworks/subnets/vnet-hub/snet-app").

export interface NameCtx {
  /** The session's name_prefix ("l06k3x9q"). */
  prefix: string;
  region: string;
  secondaryRegion: string | null;
}

/** What labs-tf's mock plan uses (scripts/labs-tf.mjs mockPlanFile): `n` is the lab's two-digit number. */
export const MOCK_NAME = {
  prefix: (n: string): string => `l${n}k3x9q`,
  region: "uksouth",
  secondaryRegion: "ukwest",
} as const;

/** The mock context for lab number `n` (two digits). */
export const mockNameCtx = (n: string): NameCtx => ({ prefix: MOCK_NAME.prefix(n), region: MOCK_NAME.region, secondaryRegion: MOCK_NAME.secondaryRegion });

function replaceAll(s: string, find: string, by: string): string {
  return find ? s.split(find).join(by) : s;
}

/** A name lower-cased with {p}, {r} and {r2} in place (the longer region first, so westus2 is never westus + "2"). */
export function normaliseName(name: string, ctx: NameCtx): string {
  let s = name.toLowerCase();
  if (ctx.prefix) s = replaceAll(s, ctx.prefix.toLowerCase(), "{p}");
  const regions: [string, string][] = [[ctx.region.toLowerCase(), "{r}"]];
  if (ctx.secondaryRegion) regions.push([ctx.secondaryRegion.toLowerCase(), "{r2}"]);
  regions.sort((a, b) => b[0].length - a[0].length);
  for (const [r, token] of regions) s = replaceAll(s, r, token);
  return s;
}

/** "<arm type>/<name path>", lower case, normalised. */
export function nodeKey(armType: string, namePath: readonly string[], ctx: NameCtx): string {
  return `${armType.toLowerCase()}/${namePath.map((n) => normaliseName(n, ctx)).join("/")}`;
}

/** The synthetic nodes' keys. */
export const SYNTHETIC_KEYS = { globalLane: "lane/global", tenantLane: "lane/tenant", gateway: "wg/gateway" } as const;

/** A planned label: the mock prefix shown as "l06…" ("l06k3x9qst" → "l06…st"). */
export function planLabel(name: string, n: string): string {
  return replaceAll(name, MOCK_NAME.prefix(n), `l${n}…`);
}

/**
 * Keys made unique: when two nodes share a key, a node outside the primary
 * group gets "#<group suffix>" ("#secondary" for rg-lab-<id>-secondary); any
 * that still collide get "#2", "#3" ... by id. Deterministic for any input
 * order. Returns id → key.
 */
export function disambiguate(nodes: readonly { id: string; key: string; group?: string | null }[], primaryRg: string): Record<string, string> {
  const sorted = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const count = new Map<string, number>();
  for (const n of sorted) count.set(n.key, (count.get(n.key) ?? 0) + 1);
  const out: Record<string, string> = {};
  const p = primaryRg.toLowerCase();
  for (const n of sorted) {
    let key = n.key;
    const g = (n.group ?? "").toLowerCase();
    if ((count.get(n.key) ?? 0) > 1 && g && g !== p) key = `${n.key}#${g.startsWith(`${p}-`) ? g.slice(p.length + 1) : g}`;
    out[n.id] = key;
  }
  const seen = new Map<string, number>();
  for (const n of sorted) {
    const k = out[n.id]!;
    const i = (seen.get(k) ?? 0) + 1;
    seen.set(k, i);
    if (i > 1) out[n.id] = `${k}#${i}`;
  }
  return out;
}
