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

/**
 * Edges sit over the containers' bodies (z = their nesting depth, a few at most: a line under a see-through body lost
 * its colour) and under the cards (flowNodes CARD_Z). The canvas uses React Flow's manual z-index mode, so this is
 * the edge's z exactly; a traced line goes one higher.
 */
export const EDGE_Z = 20;
/** How many series colours there are (--series-1 … --series-6 in the design tokens). */
export const SERIES = 6;

export interface BuildEdgesOptions {
  showDependencies: boolean;
  /** Labels on (false in the mini variant). */
  labels: boolean;
  animate: boolean;
  reducedMotion: boolean;
  /** Node ids dimmed by a search (their edges dim too). */
  dimmed?: ReadonlySet<string>;
}

const drawnEdges = (graph: TopologyGraph, byId: ReadonlyMap<string, TopoNode>) => graph.edges.filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to);

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

export function buildEdges(graph: TopologyGraph, byId: ReadonlyMap<string, TopoNode>, opts: BuildEdgesOptions): Edge<TopoEdgeData>[] {
  const out: Edge<TopoEdgeData>[] = [];
  const drawn = drawnEdges(graph, byId);
  const colourOf = new Map(sourceColours(graph, byId).map((s) => [s.source, s.colour]));
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
    const colour = e.kind === "traffic" ? colourOf.get(e.from) : undefined;
    const data: TopoEdgeData = { showLabel: opts.labels && (!s || s.first === e.id), ghost, dim, ...(label ? { label } : {}), ...(e.state ? { state: e.state } : {}), ...(colour ? { colour } : {}) };
    // Under every node: containers are see-through, so a line shows across their bodies but never over a header or a card.
    if (e.kind === "traffic") {
      const both = /^peering/i.test(e.label ?? "") || /hub connection/i.test(e.label ?? "");
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
