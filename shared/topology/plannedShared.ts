// shared/topology/plannedShared.ts
//
// Plain English: the parts of a planned diagram that Azure and AWS labs build
// the same way (planned.ts and awsPlannedGraph.ts both call these): the
// reference lookups between Terraform resources, the owner chain a folded
// resource follows to the card it is drawn in, the folded lists on cards, the
// scrub of every node's props, and the edges the rules ask for. Each cloud
// keeps its own rules, groups, placement and keys.

import { scrubProps } from "./props";
import type { TopoEdge, TopoNode } from "./model";
import type { EdgeSpec, PlannedHelpers, TfInst, TfRule } from "./rules/planned";

export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A resource instance's configuration address: "type.name" without any index. */
export const configOf = (address: string) => address.replace(/\[[^\]]*\]/g, "");

export interface RefTools {
  byConfig: Map<string, TfInst[]>;
  refs(inst: TfInst, attrs?: string[]): TfInst[];
  referrers(inst: TfInst, types?: string[], attrs?: string[]): TfInst[];
}

/**
 * Reference lookups over the instances: `refs` are the instances an attribute (or any attribute) of one instance names
 * in the HCL (a count's index picks the matching instance), `referrers` the reverse. `skipAttrs` are table entries that
 * are not references (an AWS resource's `provider`); `extra` adds references the table cannot hold (an expanded
 * template resource's ARM ids).
 */
export function makeRefTools(insts: TfInst[], table: Record<string, Record<string, string[]>>, opts: { skipAttrs?: string[]; extra?: (inst: TfInst, out: TfInst[], attrs?: string[]) => void } = {}): RefTools {
  const byConfig = new Map<string, TfInst[]>();
  for (const i of insts) if (i.config) byConfig.set(i.config, [...(byConfig.get(i.config) ?? []), i]);
  const resolve = (from: TfInst, config: string): TfInst[] => {
    const targets = byConfig.get(config) ?? [];
    if (targets.length <= 1) return targets;
    const same = targets.filter((t) => t.index !== null && t.index === from.index);
    return same.length ? same : targets;
  };
  const cache = new Map<string, TfInst[]>();
  const refs = (inst: TfInst, attrs?: string[]): TfInst[] => {
    const k = `${inst.id}|${attrs?.join(",") ?? "*"}`;
    const hit = cache.get(k);
    if (hit) return hit;
    const t = inst.config ? (table[inst.config] ?? {}) : {};
    const names = (attrs ?? Object.keys(t).sort()).filter((a) => !opts.skipAttrs?.includes(a));
    const out: TfInst[] = [];
    for (const a of names) for (const cfg of t[a] ?? []) for (const x of resolve(inst, cfg)) if (x !== inst && !out.includes(x)) out.push(x);
    opts.extra?.(inst, out, attrs);
    cache.set(k, out);
    return out;
  };
  const referrers = (inst: TfInst, types?: string[], attrs?: string[]): TfInst[] => insts.filter((r) => r !== inst && (!types || types.includes(r.type)) && refs(r, attrs).includes(inst));
  return { byConfig, refs, referrers };
}

/** True when making `t` the owner of `i` would close a loop of owners. */
export function ownerCycle(owner: ReadonlyMap<string, TfInst>, i: TfInst, t: TfInst): boolean {
  for (let cur: TfInst | undefined = t, d = 0; cur && d < 20; cur = owner.get(cur.id), d++) if (cur === i) return true;
  return false;
}

/** The node id an instance is drawn as: itself, or the card (or group) its owner chain ends in; null on a loop. */
export function homeOf(i: TfInst, owner: ReadonlyMap<string, TfInst>, stop: (i: TfInst) => string | null, direct?: ReadonlyMap<string, string>, seen = new Set<string>()): string | null {
  const s = stop(i);
  if (s) return s;
  const d = direct?.get(i.id);
  if (d) return d;
  const o = owner.get(i.id);
  if (!o) return i.id;
  if (seen.has(i.id)) return null;
  seen.add(i.id);
  return homeOf(o, owner, stop, direct, seen);
}

/** Lists every folded instance on its home card. */
export function addFoldedLists(insts: TfInst[], isFolded: (i: TfInst) => boolean, home: (i: TfInst) => string | null, nodes: Map<string, TopoNode>, ruleOf: (i: TfInst) => TfRule, labelOf: (i: TfInst) => string, armOf: (i: TfInst) => string | null): void {
  for (const i of insts) {
    if (!isFolded(i)) continue;
    const h = home(i);
    const n = h ? nodes.get(h) : undefined;
    if (!n) continue;
    (n.folded ??= []).push({ id: i.id, label: ruleOf(i).foldedLabel ?? labelOf(i), armType: armOf(i) });
  }
}

/** Scrubs every node's raw props into `n.props` (an empty chips list is dropped first); returns how many values were withheld. */
export function scrubNodes(nodes: Map<string, TopoNode>, raw: Map<string, Record<string, unknown>>): number {
  let withheld = 0;
  for (const n of nodes.values()) {
    const r = { ...(raw.get(n.id) ?? {}) };
    if (Array.isArray(r.chips)) r.chips = (r.chips as string[]).length ? [...(r.chips as string[])] : undefined;
    const s = scrubProps(r);
    withheld += s.withheld;
    n.props = s.props;
  }
  return withheld;
}

/** The edges every rule asks for, between node ids that exist; one per kind, ends and label. */
export function collectEdges(insts: TfInst[], ruleOf: (i: TfInst) => TfRule, helpers: PlannedHelpers, home: (i: TfInst) => string | null, nodes: Map<string, TopoNode>): Map<string, TopoEdge> {
  const edges = new Map<string, TopoEdge>();
  const endOf = (x: TfInst | string): string | null => (typeof x === "string" ? (x.startsWith("node:") ? x.slice(5) : x) : home(x));
  for (const i of insts) {
    const rule = ruleOf(i);
    if (!rule.edges) continue;
    for (const spec of rule.edges(i, helpers) as EdgeSpec[]) {
      let from = endOf(spec.from);
      let to = endOf(spec.to);
      if (!from || !to || from === to || !nodes.has(from) || !nodes.has(to)) continue;
      if (spec.undirected && to < from) [from, to] = [to, from];
      const via = (spec.via ?? i).id;
      const id = `${spec.kind}:${from}>${to}:${spec.label ?? ""}`;
      if (edges.has(id)) continue;
      edges.set(id, { id, from, to, kind: spec.kind, ...(spec.label ? { label: spec.label } : {}), via });
    }
  }
  return edges;
}
