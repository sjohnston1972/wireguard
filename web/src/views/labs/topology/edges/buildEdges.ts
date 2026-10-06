// views/labs/topology/edges/buildEdges.ts
//
// Plain English: a graph's edges as React Flow edges. Traffic edges are
// focusable with a name ("lb-svc to vm-svc: TCP 80→80"); dependency edges are
// not focusable, not selectable and hidden when the toggle is off. No edge
// animates unless "Animate traffic" is on, never under reduced motion.

import { MarkerType, type Edge } from "@xyflow/react";
import type { TopologyGraph, TopoNode } from "@shared/topology/model";
import { edgeName } from "../words";
import type { TopoEdgeData } from "./TopoEdges";

export interface BuildEdgesOptions {
  showDependencies: boolean;
  /** Labels on (false in the mini variant). */
  labels: boolean;
  animate: boolean;
  reducedMotion: boolean;
  /** Node ids dimmed by a search (their edges dim too). */
  dimmed?: ReadonlySet<string>;
}

export function buildEdges(graph: TopologyGraph, byId: ReadonlyMap<string, TopoNode>, opts: BuildEdgesOptions): Edge<TopoEdgeData>[] {
  const out: Edge<TopoEdgeData>[] = [];
  for (const e of graph.edges) {
    if (!byId.has(e.from) || !byId.has(e.to) || e.from === e.to) continue;
    const ghost = e.id.startsWith("ghost:");
    const dim = !!opts.dimmed && (opts.dimmed.has(e.from) || opts.dimmed.has(e.to));
    const data: TopoEdgeData = { showLabel: opts.labels, ghost, dim, ...(e.label ? { label: e.label } : {}), ...(e.state ? { state: e.state } : {}) };
    if (e.kind === "traffic") {
      const both = /^peering/i.test(e.label ?? "") || /hub connection/i.test(e.label ?? "");
      const marker = { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "var(--topo-edge)" };
      out.push({
        id: e.id,
        source: e.from,
        target: e.to,
        type: "traffic",
        data,
        focusable: true,
        selectable: true,
        ariaLabel: edgeName(e, byId),
        animated: opts.animate && !opts.reducedMotion,
        markerEnd: marker,
        ...(both ? { markerStart: marker } : {}),
      });
    } else {
      out.push({
        id: e.id,
        source: e.from,
        target: e.to,
        type: "dependency",
        data,
        focusable: false,
        selectable: false,
        deletable: false,
        ariaLabel: edgeName(e, byId),
        hidden: !opts.showDependencies,
        animated: false,
        interactionWidth: 0,
      });
    }
  }
  return out;
}
