// views/labs/topology/edges/specs.ts
//
// Plain English: which of a graph's edges are drawn, each traffic source's
// colour, and which line carries the label chip of a pair (edges of one kind
// between the same two nodes share one chip, a line each). Pure, with no
// React Flow in it, so the canvas (buildEdges.ts) and the static diagrams of
// the lab readmes (static/architectureSvg.ts) draw the same lines.

import type { TopologyGraph, TopoEdge, TopoNode } from "@shared/topology/model";

/** How many series colours there are (--series-1 … --series-6 in the design tokens). */
export const SERIES = 6;

/** The edges between two nodes that are both drawn (no loops). */
export const drawnEdges = (graph: TopologyGraph, byId: ReadonlyMap<string, TopoNode>): TopoEdge[] => graph.edges.filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to);

/** Each traffic source's colour (1-6, repeating), in the order its first line appears in the graph. */
export function sourceColours(graph: TopologyGraph, byId: ReadonlyMap<string, TopoNode>): { source: string; label: string; colour: number }[] {
  const out: { source: string; label: string; colour: number }[] = [];
  const seen = new Set<string>();
  for (const e of drawnEdges(graph, byId)) {
    if (e.kind !== "traffic" || seen.has(e.from)) continue;
    seen.add(e.from);
    out.push({ source: e.from, label: byId.get(e.from)!.label, colour: (out.length % SERIES) + 1 });
  }
  return out;
}

export interface EdgeSpec {
  edge: TopoEdge;
  /** The chip's text when this line carries its pair's chip (the pair's labels, a line each). */
  label?: string;
  /** False when another line of the pair carries the chip. */
  carriesLabel: boolean;
  /** A traffic line's series colour (1-6, by its source). */
  colour?: number;
  /** A peering or hub connection: arrowheads at both ends. */
  both: boolean;
}

/** Every drawn edge, in graph order, with its colour and its share of the pair's label chip. */
export function edgeSpecs(graph: TopologyGraph, byId: ReadonlyMap<string, TopoNode>): EdgeSpec[] {
  const drawn = drawnEdges(graph, byId);
  const colourOf = new Map(sourceColours(graph, byId).map((s) => [s.source, s.colour]));
  // Edges of one kind between the same two nodes (either way: a rule and its outbound return) would draw their labels
  // on top of each other: the first carries them all, a line each, and the rest none.
  const pair = (e: TopoEdge) => `${e.kind}|${[e.from, e.to].sort().join("|")}`;
  const shared = new Map<string, { first: string; labels: string[] }>();
  for (const e of drawn) {
    if (!e.label) continue;
    const s = shared.get(pair(e));
    if (!s) shared.set(pair(e), { first: e.id, labels: [e.label] });
    else if (!s.labels.includes(e.label)) s.labels.push(e.label);
  }
  return drawn.map((e) => {
    const s = shared.get(pair(e));
    const label = s && s.first === e.id ? s.labels.join("\n") : undefined;
    const colour = e.kind === "traffic" ? colourOf.get(e.from) : undefined;
    const both = e.kind === "traffic" && (/^peering/i.test(e.label ?? "") || /hub connection/i.test(e.label ?? ""));
    return { edge: e, carriesLabel: !s || s.first === e.id, both, ...(label ? { label } : {}), ...(colour ? { colour } : {}) };
  });
}
