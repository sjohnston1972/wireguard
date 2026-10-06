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
  const drawn = graph.edges.filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to);
  // Edges of one kind between the same two nodes (either way: a rule and its outbound return) would draw their labels
  // on top of each other: the first carries them all, a line each, and the rest none.
  const pair = (e: (typeof drawn)[number]) => `${e.kind}|${[e.from, e.to].sort().join("|")}`;
  const shared = new Map<string, { first: string; labels: string[] }>();
  for (const e of drawn) {
    if (!e.label) continue;
    const s = shared.get(pair(e));
    if (!s) shared.set(pair(e), { first: e.id, labels: [e.label] });
    else if (!s.labels.includes(e.label)) s.labels.push(e.label);
  }
  for (const e of drawn) {
    const ghost = e.id.startsWith("ghost:");
    const dim = !!opts.dimmed && (opts.dimmed.has(e.from) || opts.dimmed.has(e.to));
    const s = shared.get(pair(e));
    const label = s && s.first === e.id ? s.labels.join("\n") : undefined;
    const data: TopoEdgeData = { showLabel: opts.labels && (!s || s.first === e.id), ghost, dim, ...(label ? { label } : {}), ...(e.state ? { state: e.state } : {}) };
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
