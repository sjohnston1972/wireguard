// views/labs/topology/stacks.ts
//
// Plain English: big labs stay readable (lab topology spec ruling 19). When
// one container holds more than STACK_AT (8) resources of one kind, they are
// drawn as one stack card ("12 × VM") whose members the details panel lists.
// Edges to any member go to the stack, once. Pure and deterministic.

import type { TopologyGraph, TopoNode, TopoEdge, TopoHealth, TopoPropValue, TopoTone } from "@shared/topology/model";
import { isGroupKind } from "@shared/topology/model";
import { KINDS, STACK_AT } from "@shared/topology/kinds";

export interface StackedGraph {
  graph: TopologyGraph;
  /** Stack node id → its members, in id order. */
  stacks: Record<string, TopoNode[]>;
}

/** The id of the stack card for `kind` under `parent` (null: the root). */
export const stackIdOf = (parent: string | null, kind: string): string => `stack:${parent ?? ""}/${kind}`;
export const isStackId = (id: string): boolean => id.startsWith("stack:");

const RANK: Record<TopoTone, number> = { bad: 3, warn: 2, unknown: 1, ok: 0 };
const same = (a: TopoPropValue, b: TopoPropValue) => JSON.stringify(a) === JSON.stringify(b);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function stackHealth(members: TopoNode[]): TopoHealth | undefined {
  const hs = members.map((m) => m.health).filter((h): h is TopoHealth => !!h);
  if (!hs.length) return undefined;
  if (hs.length === members.length && hs.every((h) => h.word === hs[0]!.word && h.tone === hs[0]!.tone)) return hs[0];
  const worst = hs.reduce((a, b) => (RANK[b.tone] > RANK[a.tone] ? b : a));
  if (worst.tone === "ok") return { tone: "ok", word: "Mixed" };
  const notOk = hs.filter((h) => h.tone !== "ok").length;
  return { tone: worst.tone, word: `${notOk} of ${members.length} not OK` };
}

/** `graph` with every run of more than STACK_AT same-kind assets in one container folded into a stack card. */
export function stackGraph(graph: TopologyGraph): StackedGraph {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const groups = new Map<string, TopoNode[]>();
  for (const n of graph.nodes) {
    if (isGroupKind(n.kind) || n.kind === "gateway") continue;
    const p = n.parent && ids.has(n.parent) ? n.parent : null;
    const k = stackIdOf(p, n.kind);
    const list = groups.get(k);
    if (list) list.push(n);
    else groups.set(k, [n]);
  }
  const stacks: Record<string, TopoNode[]> = {};
  const memberOf = new Map<string, string>();
  for (const [sid, members] of groups) {
    if (members.length <= STACK_AT) continue;
    members.sort((a, b) => cmp(a.id, b.id));
    stacks[sid] = members;
    for (const m of members) memberOf.set(m.id, sid);
  }
  if (!memberOf.size) return { graph, stacks };

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodes: TopoNode[] = graph.nodes.filter((n) => !memberOf.has(n.id));
  for (const [sid, members] of Object.entries(stacks)) {
    const first = members[0]!;
    const parent = first.parent && ids.has(first.parent) ? first.parent : undefined;
    const parentKey = parent ? byId.get(parent)!.key : "root";
    const props: Record<string, TopoPropValue> = {};
    for (const [k, v] of Object.entries(first.props)) if (members.every((m) => Object.hasOwn(m.props, k) && same(m.props[k]!, v))) props[k] = v;
    const health = stackHealth(members);
    nodes.push({
      id: sid,
      key: `stack/${parentKey}/${first.kind}`,
      kind: first.kind,
      label: `${members.length} × ${KINDS[first.kind].word}`,
      props,
      ...(parent ? { parent } : {}),
      ...(health ? { health } : {}),
    });
  }
  nodes.sort((a, b) => cmp(a.id, b.id));

  const seen = new Set<string>();
  const edges: TopoEdge[] = [];
  for (const e of [...graph.edges].sort((a, b) => cmp(a.id, b.id))) {
    const from = memberOf.get(e.from) ?? e.from;
    const to = memberOf.get(e.to) ?? e.to;
    if (from === to) continue;
    const sig = `${from}\u0000${to}\u0000${e.kind}\u0000${e.label ?? ""}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    edges.push(from === e.from && to === e.to ? e : { ...e, from, to });
  }
  return { graph: { ...graph, nodes, edges }, stacks };
}
