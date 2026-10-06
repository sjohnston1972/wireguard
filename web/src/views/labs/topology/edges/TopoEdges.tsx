// views/labs/topology/edges/TopoEdges.tsx
//
// Plain English: the diagram's two edge styles (lab topology spec §9.2).
// Traffic edges (load balancer rules, peerings, next hops, private
// endpoints...) are solid smoothstep lines with a label pill. Dependency
// edges (role assignments, diagnostics, zone links...) are thinner dashed
// lines, never focusable or clickable, and can be hidden. Both run under the
// nodes (containers are see-through) and leave and enter
// at the nearest sides of their two boxes, or the sides that keep them from
// passing under another card or a header (route.ts), so they follow a
// dragged node.

import { BaseEdge, EdgeLabelRenderer, useInternalNode, useStore, type Edge, type EdgeProps, type InternalNode, type ReactFlowState } from "@xyflow/react";
import { createContext, useContext, useEffect } from "react";
import type { TopoHealth } from "@shared/topology/model";
import type { Bounds } from "./floating";
import { routeEdge, type Obstacle } from "./route";
import { labelSize, labelSpot, type Box } from "./labelSpot";
import { HEADER, SUBNET_HEADER } from "../layout";

export interface TopoEdgeData extends Record<string, unknown> {
  label?: string;
  /** False in the mini variant: no labels. */
  showLabel: boolean;
  state?: TopoHealth;
  ghost?: boolean;
  dim?: boolean;
}
export type TrafficFlowEdge = Edge<TopoEdgeData, "traffic">;
export type DependencyFlowEdge = Edge<TopoEdgeData, "dependency">;

const boundsOf = (n: InternalNode): Bounds => ({
  x: n.internals.positionAbsolute.x,
  y: n.internals.positionAbsolute.y,
  w: n.measured?.width ?? n.width ?? 0,
  h: n.measured?.height ?? n.height ?? 0,
});

/** What a line should not pass under and a label should not cover: every card, and every container's header strip. */
function obstaclesOf(s: ReactFlowState): Obstacle[] {
  const out: Obstacle[] = [];
  for (const n of s.nodeLookup.values()) {
    const w = n.measured?.width ?? n.width ?? 0;
    const h = n.measured?.height ?? n.height ?? 0;
    const { x, y } = n.internals.positionAbsolute;
    if (n.type === "topoAsset") out.push({ id: n.id, x, y, w, h, head: false });
    else if (n.type === "topoGroup") out.push({ id: n.id, x, y, w, h: (n.data as { node?: { kind?: string } }).node?.kind === "subnet" ? SUBNET_HEADER : HEADER, head: true });
  }
  return out;
}
const sameBoxes = (a: Obstacle[], b: Obstacle[]) => a.length === b.length && a.every((p, i) => p.id === b[i]!.id && p.x === b[i]!.x && p.y === b[i]!.y && p.w === b[i]!.w && p.h === b[i]!.h);

function useGeometry(source: string, target: string) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  const obstacles = useStore(obstaclesOf, sameBoxes);
  if (!s || !t) return null;
  return { ...routeEdge(boundsOf(s), boundsOf(t), obstacles, source, target), obstacles };
}

/**
 * The label chips already placed on this canvas, by edge id: a label keeps off the others too. Edges render in
 * order, so each label sees the ones before it (and, when it alone re-renders, all the others).
 */
export const PlacedLabels = createContext<Map<string, Box> | null>(null);

function Label({ id, path, x: cx, y: cy, data, className, obstacles }: { id: string; path: string; x: number; y: number; data: TopoEdgeData; className: string; obstacles: readonly Box[] }) {
  const placed = useContext(PlacedLabels);
  const on = data.showLabel && !!(data.label || data.state);
  const text = [data.label, data.state?.word].filter(Boolean).join(" · ");
  useEffect(() => () => void placed?.delete(id), [placed, id]);
  if (!on) {
    placed?.delete(id);
    return null;
  }
  const size = labelSize(text);
  const others = placed ? [...placed].filter(([k]) => k !== id).map(([, b]) => b) : [];
  const { x, y } = labelSpot(path, { x: cx, y: cy }, size, others.length ? [...obstacles, ...others] : obstacles);
  placed?.set(id, { x: x - size.w / 2, y: y - size.h / 2, w: size.w, h: size.h });
  return (
    <EdgeLabelRenderer>
      <div
        className={`${className}${data.state ? ` topo-edge-label--${data.state.tone}` : ""}${data.dim ? " topo-edge-label--dim" : ""}${data.ghost ? " topo-edge-label--ghost" : ""}`}
        style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
        aria-hidden="true"
      >
        {text}
      </div>
    </EdgeLabelRenderer>
  );
}

export function TrafficEdge({ id, source, target, data, markerEnd, markerStart, style }: EdgeProps<TrafficFlowEdge>) {
  const g = useGeometry(source, target);
  if (!g) return null;
  const d = data ?? { showLabel: false };
  return (
    <>
      <BaseEdge id={id} path={g.path} markerEnd={markerEnd} markerStart={markerStart} style={style} className={`topo-edge topo-edge--traffic${d.ghost ? " topo-edge--ghost" : ""}${d.dim ? " topo-edge--dim" : ""}`} />
      <Label id={id} path={g.path} x={g.labelX} y={g.labelY} obstacles={g.obstacles} data={d} className="topo-edge-label nodrag nopan" />
    </>
  );
}

export function DependencyEdge({ id, source, target, data, style }: EdgeProps<DependencyFlowEdge>) {
  const g = useGeometry(source, target);
  if (!g) return null;
  const d = data ?? { showLabel: false };
  return (
    <>
      <BaseEdge id={id} path={g.path} style={style} interactionWidth={0} className={`topo-edge topo-edge--dependency${d.ghost ? " topo-edge--ghost" : ""}${d.dim ? " topo-edge--dim" : ""}`} />
      <Label id={id} path={g.path} x={g.labelX} y={g.labelY} obstacles={g.obstacles} data={d} className="topo-edge-label topo-edge-label--dependency" />
    </>
  );
}

export const EDGE_TYPES = { traffic: TrafficEdge, dependency: DependencyEdge };
