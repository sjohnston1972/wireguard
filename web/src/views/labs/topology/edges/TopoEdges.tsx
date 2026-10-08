// views/labs/topology/edges/TopoEdges.tsx
//
// Plain English: the diagram's two edge styles (lab topology spec §9.2).
// Traffic edges (load balancer rules, peerings, next hops, private
// endpoints...) are solid lines in their source's colour with a label pill.
// Dependency edges (role assignments, diagnostics, zone links...) are
// thinner dashed neutral lines, never focusable or clickable, and can be
// hidden. Both run under the nodes (containers are see-through).
//
// Where a line runs comes from the canvas's router (router.ts, through the
// Routes context): every line in a lane of its own, from a port of its own,
// round the cards, its label on its own stretch. While a node is dragged (or
// with no router, as in a bare React Flow) each line falls back to the nearest
// sides of its two boxes, or the sides that keep it from passing under another
// card or a header (route.ts), so it follows the dragged node.

import { BaseEdge, EdgeLabelRenderer, useInternalNode, useStore, type Edge, type EdgeProps, type InternalNode, type ReactFlowState } from "@xyflow/react";
import { createContext, useContext, useEffect, type CSSProperties } from "react";
import type { TopoHealth } from "@shared/topology/model";
import type { Bounds } from "./floating";
import { routeEdge, type Obstacle } from "./route";
import { labelSize, labelSpot, type Box } from "./labelSpot";
import { edgeLabelText, type RoutedEdge } from "./router";
import { HEADER, SUBNET_HEADER } from "../layout";

export interface TopoEdgeData extends Record<string, unknown> {
  label?: string;
  /** False in the mini variant: no labels. */
  showLabel: boolean;
  state?: TopoHealth;
  ghost?: boolean;
  dim?: boolean;
  /** A traffic line's series colour (1-6, by its source); none for dependencies. */
  colour?: number;
  /** Trace highlighting: lit, or dimmed while something else is traced. */
  trace?: "on" | "off";
}
export type TrafficFlowEdge = Edge<TopoEdgeData, "traffic">;
export type DependencyFlowEdge = Edge<TopoEdgeData, "dependency">;

/** The router's routes by edge id (null: none yet, or a node is being dragged). */
export const Routes = createContext<ReadonlyMap<string, RoutedEdge> | null>(null);

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

/**
 * The label chips already placed on this canvas by the fallback routing, by edge id: a label keeps off the others
 * too. Edges render in order, so each label sees the ones before it.
 */
export const PlacedLabels = createContext<Map<string, Box> | null>(null);

const edgeClass = (kind: "traffic" | "dependency", d: TopoEdgeData) =>
  ["topo-edge", `topo-edge--${kind}`, d.colour && `topo-edge--c${d.colour}`, d.ghost && "topo-edge--ghost", d.dim && "topo-edge--dim", d.trace === "on" && "topo-edge--trace", d.trace === "off" && "topo-edge--faded"].filter(Boolean).join(" ");

const labelClass = (base: string, d: TopoEdgeData) =>
  [base, d.colour && `topo-edge-label--c${d.colour}`, d.state && `topo-edge-label--${d.state.tone}`, d.dim && "topo-edge-label--dim", d.ghost && "topo-edge-label--ghost", d.trace === "on" && "topo-edge-label--trace", d.trace === "off" && "topo-edge-label--faded"].filter(Boolean).join(" ");

function Chip({ x, y, text, className }: { x: number; y: number; text: string; className: string }) {
  return (
    <EdgeLabelRenderer>
      <div className={className} style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }} aria-hidden="true">
        {text}
      </div>
    </EdgeLabelRenderer>
  );
}

/** A label placed by the fallback routing: on its line, clear of the cards, headers and labels placed before it. */
function FloatingLabel({ id, path, x: cx, y: cy, data, className, obstacles }: { id: string; path: string; x: number; y: number; data: TopoEdgeData; className: string; obstacles: readonly Box[] }) {
  const placed = useContext(PlacedLabels);
  const text = edgeLabelText(data);
  useEffect(() => () => void placed?.delete(id), [placed, id]);
  if (!text) {
    placed?.delete(id);
    return null;
  }
  const size = labelSize(text);
  const others = placed ? [...placed].filter(([k]) => k !== id).map(([, b]) => b) : [];
  const { x, y } = labelSpot(path, { x: cx, y: cy }, size, others.length ? [...obstacles, ...others] : obstacles);
  placed?.set(id, { x: x - size.w / 2, y: y - size.h / 2, w: size.w, h: size.h });
  return <Chip x={x} y={y} text={text} className={labelClass(className, data)} />;
}

interface LineProps {
  id: string;
  source: string;
  target: string;
  kind: "traffic" | "dependency";
  data: TopoEdgeData;
  markerEnd?: string;
  markerStart?: string;
  style?: CSSProperties;
  labelClassName: string;
}

/** A line along the router's route. */
function RoutedLine({ id, kind, data, markerEnd, markerStart, style, labelClassName, route }: LineProps & { route: RoutedEdge }) {
  const text = edgeLabelText(data);
  return (
    <>
      <BaseEdge id={id} path={route.path} markerEnd={markerEnd} markerStart={markerStart} style={style} className={edgeClass(kind, data)} {...(kind === "dependency" ? { interactionWidth: 0 } : {})} />
      {text && route.label && <Chip x={route.label.x} y={route.label.y} text={text} className={labelClass(labelClassName, data)} />}
    </>
  );
}

/** A line between the nearest sides of its two boxes (no route from the router). */
function FloatingLine({ id, source, target, kind, data, markerEnd, markerStart, style, labelClassName }: LineProps) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  const obstacles = useStore(obstaclesOf, sameBoxes);
  if (!s || !t) return null;
  const g = routeEdge(boundsOf(s), boundsOf(t), obstacles, source, target);
  return (
    <>
      <BaseEdge id={id} path={g.path} markerEnd={markerEnd} markerStart={markerStart} style={style} className={edgeClass(kind, data)} {...(kind === "dependency" ? { interactionWidth: 0 } : {})} />
      <FloatingLabel id={id} path={g.path} x={g.labelX} y={g.labelY} obstacles={obstacles} data={data} className={labelClassName} />
    </>
  );
}

function Line(props: LineProps) {
  const route = useContext(Routes)?.get(props.id);
  return route ? <RoutedLine {...props} route={route} /> : <FloatingLine {...props} />;
}

export function TrafficEdge({ id, source, target, data, markerEnd, markerStart, style }: EdgeProps<TrafficFlowEdge>) {
  return <Line id={id} source={source} target={target} kind="traffic" data={data ?? { showLabel: false }} markerEnd={markerEnd} markerStart={markerStart} style={style} labelClassName="topo-edge-label nodrag nopan" />;
}

export function DependencyEdge({ id, source, target, data, style }: EdgeProps<DependencyFlowEdge>) {
  return <Line id={id} source={source} target={target} kind="dependency" data={data ?? { showLabel: false }} style={style} labelClassName="topo-edge-label topo-edge-label--dependency" />;
}

export const EDGE_TYPES = { traffic: TrafficEdge, dependency: DependencyEdge };
