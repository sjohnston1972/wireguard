// views/labs/topology/trace.ts
//
// Plain English: trace highlighting (Steven, 2026-10-08: "it is in no way
// clear what lines lead from which element to the next"). Hovering, focusing
// or selecting a resource lights up its lines and the resources at their other
// ends and dims everything else; hovering or focusing a line lights it and its
// two ends. A resource with no (shown) lines traces nothing, so nothing dims
// for no reason. Pure: the edges and what is pointed at in, the sets out.

import type { Edge } from "@xyflow/react";
import type { TopoEdgeData } from "./edges/TopoEdges";
import type { TopoFlowNode } from "./flowNodes";

export type TraceTarget = { kind: "node" | "edge"; id: string } | null;

export interface TraceSets {
  nodes: Set<string>;
  edges: Set<string>;
}

/** What `target` lights up among `edges` (hidden ones never count); null when nothing would. */
export function traceSets(edges: readonly { id: string; source: string; target: string; hidden?: boolean }[], target: TraceTarget): TraceSets | null {
  if (!target) return null;
  const shown = edges.filter((e) => !e.hidden);
  if (target.kind === "edge") {
    const e = shown.find((x) => x.id === target.id);
    return e ? { nodes: new Set([e.source, e.target]), edges: new Set([e.id]) } : null;
  }
  const mine = shown.filter((e) => e.source === target.id || e.target === target.id);
  if (!mine.length) return null;
  return { nodes: new Set([target.id, ...mine.flatMap((e) => [e.source, e.target])]), edges: new Set(mine.map((e) => e.id)) };
}

/** The edges with the trace marked on them (lit ones drawn over the others). */
export function traceEdges(edges: Edge<TopoEdgeData>[], sets: TraceSets | null): Edge<TopoEdgeData>[] {
  if (!sets) return edges;
  return edges.map((e) => {
    const on = sets.edges.has(e.id);
    return { ...e, zIndex: (e.zIndex ?? 0) + (on ? 1 : 0), data: { ...e.data!, trace: on ? "on" : "off" } };
  });
}

/** The nodes with the trace marked on the resource cards (containers stay as they are). */
export function traceNodes(nodes: TopoFlowNode[], sets: TraceSets | null): TopoFlowNode[] {
  if (!sets) return nodes;
  return nodes.map((n) => (n.type === "topoAsset" ? { ...n, className: `${n.className ?? ""} ${sets.nodes.has(n.id) ? "topo-trace-on" : "topo-trace-off"}`.trim() } : n));
}
