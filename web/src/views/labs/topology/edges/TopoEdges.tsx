// views/labs/topology/edges/TopoEdges.tsx
//
// Plain English: the diagram's two edge styles (lab topology spec §9.2).
// Traffic edges (load balancer rules, peerings, next hops, private
// endpoints...) are solid smoothstep lines with a label pill. Dependency
// edges (role assignments, diagnostics, zone links...) are thinner dashed
// lines, never focusable or clickable, and can be hidden. Both leave and enter
// at the nearest sides of their two boxes (floating.ts), so they follow a
// dragged node.

import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, Position, useInternalNode, type Edge, type EdgeProps, type InternalNode } from "@xyflow/react";
import type { TopoHealth } from "@shared/topology/model";
import { floatingEnds, type Bounds, type Side } from "./floating";

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

const POS: Record<Side, Position> = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left };

const boundsOf = (n: InternalNode): Bounds => ({
  x: n.internals.positionAbsolute.x,
  y: n.internals.positionAbsolute.y,
  w: n.measured?.width ?? n.width ?? 0,
  h: n.measured?.height ?? n.height ?? 0,
});

function useGeometry(source: string, target: string) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!s || !t) return null;
  const e = floatingEnds(boundsOf(s), boundsOf(t));
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX: e.sx,
    sourceY: e.sy,
    sourcePosition: POS[e.sourceSide],
    targetX: e.tx,
    targetY: e.ty,
    targetPosition: POS[e.targetSide],
    borderRadius: 10,
    offset: 18,
  });
  return { path, labelX, labelY };
}

function Label({ x, y, data, className }: { x: number; y: number; data: TopoEdgeData; className: string }) {
  if (!data.showLabel || (!data.label && !data.state)) return null;
  const text = [data.label, data.state?.word].filter(Boolean).join(" · ");
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
      <Label x={g.labelX} y={g.labelY} data={d} className="topo-edge-label nodrag nopan" />
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
      <Label x={g.labelX} y={g.labelY} data={d} className="topo-edge-label topo-edge-label--dependency" />
    </>
  );
}

export const EDGE_TYPES = { traffic: TrafficEdge, dependency: DependencyEdge };
