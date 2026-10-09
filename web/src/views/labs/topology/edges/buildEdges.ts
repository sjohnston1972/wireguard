// views/labs/topology/edges/buildEdges.ts
//
// Plain English: a graph's edges as React Flow edges. Traffic edges are
// focusable with a name ("lb-svc to vm-svc: TCP 80→80"); dependency edges are
// not focusable, not selectable and hidden when the toggle is off. No edge
// animates unless "Animate traffic" is on, never under reduced motion.
//
// Traffic lines take their source's colour (Steven, 2026-10-08: "lines of
// different colour coming from the load balancer compared to the agw would
// also help"): every line from one resource shares one of six series colours,
// given in graph order so a lab always looks the same; the arrowhead and the
// label chip's border match. Dependency lines stay neutral. Colour is never
// the only cue: the labels, the Legend ("from lbi-web") and the trace
// highlighting stay.

import { MarkerType, type Edge } from "@xyflow/react";
import type { TopologyGraph, TopoNode } from "@shared/topology/model";
import { edgeName } from "../words";
import type { TopoEdgeData } from "./TopoEdges";
import { edgeSpecs } from "./specs";

/**
 * Edges sit over the containers' bodies (z = their nesting depth, a few at most: a line under a see-through body lost
 * its colour) and under the cards (flowNodes CARD_Z). The canvas uses React Flow's manual z-index mode, so this is
 * the edge's z exactly; a traced line goes one higher.
 */
export const EDGE_Z = 20;
export { SERIES, sourceColours } from "./specs";

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
  for (const { edge: e, label, carriesLabel, colour, both } of edgeSpecs(graph, byId)) {
    const ghost = e.id.startsWith("ghost:");
    const dim = !!opts.dimmed && (opts.dimmed.has(e.from) || opts.dimmed.has(e.to));
    const data: TopoEdgeData = { showLabel: opts.labels && carriesLabel, ghost, dim, ...(label ? { label } : {}), ...(e.state ? { state: e.state } : {}), ...(colour ? { colour } : {}) };
    // Under every node: containers are see-through, so a line shows across their bodies but never over a header or a card.
    if (e.kind === "traffic") {
      const marker = { type: MarkerType.ArrowClosed, width: 14, height: 14, color: colour ? `var(--series-${colour})` : "var(--topo-edge)" };
      out.push({
        id: e.id,
        source: e.from,
        target: e.to,
        type: "traffic",
        zIndex: EDGE_Z,
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
        zIndex: EDGE_Z,
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
