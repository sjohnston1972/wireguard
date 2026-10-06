// views/labs/topology/flowNodes.ts
//
// Plain English: the laid-out graph as React Flow nodes, and React Flow's
// node changes as saved moves. Children nest with parentId, stay inside their
// parent (extent "parent") and grow it when dragged to its edge
// (expandParent). Each node carries its accessible name, its badge, whether
// it is a ghost and whether a search dims or highlights it.

import type { Node, NodeChange } from "@xyflow/react";
import { Position } from "@xyflow/react";
import type { TopoNode } from "@shared/topology/model";
import { isGroupKind } from "@shared/topology/model";
import { badgeOf, type NodeDiffStatus } from "@shared/topology/diff";
import { validTopologyKey } from "@shared/topology/layout";
import type { DiagramVariant } from "./contract";
import type { LaidNode, TopologyLayoutResult } from "./layout";
import { matchesSearch, nodeName } from "./words";

export interface TopoNodeData extends Record<string, unknown> {
  node: TopoNode;
  badge: string | null;
  ghost: boolean;
  compact: boolean;
  dim: boolean;
  match: boolean;
}
export type TopoFlowNode = Node<TopoNodeData, "topoGroup" | "topoAsset">;

export interface FlowNodeOptions {
  status: Record<string, NodeDiffStatus>;
  variant: DiagramVariant;
  selected: string | null;
  search: string;
  deploying?: boolean;
}

const SIDES = [Position.Top, Position.Right, Position.Bottom, Position.Left] as const;

/** Handle bounds for each side (React Flow measures real ones in the browser; these stand in until then). */
export function sideHandles(w: number, h: number) {
  return SIDES.map((p) => ({
    id: p,
    type: "source" as const,
    position: p,
    x: p === Position.Right ? w : p === Position.Left ? 0 : w / 2,
    y: p === Position.Bottom ? h : p === Position.Top ? 0 : h / 2,
    width: 1,
    height: 1,
  }));
}

/** Ids matching a search, plus the groups holding a match (kept bright, not highlighted). */
export function searchSets(nodes: Iterable<TopoNode>, byId: ReadonlyMap<string, TopoNode>, search: string): { match: Set<string>; keep: Set<string> } | null {
  if (!search.trim()) return null;
  const match = new Set<string>();
  const keep = new Set<string>();
  for (const n of nodes) {
    if (!matchesSearch(n, search)) continue;
    match.add(n.id);
    let p = n.parent;
    const seen = new Set<string>();
    while (p && byId.has(p) && !seen.has(p)) {
      seen.add(p);
      keep.add(p);
      p = byId.get(p)!.parent;
    }
  }
  return { match, keep };
}

export function toFlowNodes(laid: TopologyLayoutResult, byId: ReadonlyMap<string, TopoNode>, opts: FlowNodeOptions): TopoFlowNode[] {
  const sets = searchSets(byId.values(), byId, opts.search);
  const mini = opts.variant === "mini";
  return laid.nodes.map((l: LaidNode) => {
    const node = byId.get(l.id)!;
    const status = opts.status[node.key];
    const badge = status ? badgeOf(status, { deploying: opts.deploying }) : null;
    const ghost = status === "missing" || status === "unlisted";
    const group = isGroupKind(node.kind);
    const parent = l.parent ? byId.get(l.parent) : undefined;
    const match = !!sets?.match.has(node.id);
    const dim = !!sets && !match && !sets.keep.has(node.id);
    return {
      id: node.id,
      type: group ? "topoGroup" : "topoAsset",
      position: { x: l.x, y: l.y },
      width: l.w,
      height: l.h,
      ...(l.parent ? { parentId: l.parent, extent: "parent" as const, expandParent: true } : {}),
      data: { node, badge, ghost, compact: mini, dim, match },
      ariaLabel: nodeName(node, parent, badge),
      selected: opts.selected === node.id,
      draggable: !mini && node.kind !== "gateway",
      selectable: !mini,
      focusable: !mini,
      handles: sideHandles(l.w, l.h),
      className: group ? `topo-flow-group topo-flow-group--${node.kind}` : "topo-flow-asset",
    };
  });
}

export interface Move {
  key: string;
  at: { x: number; y: number; p: string | null };
}

/** The moves to save from a batch of node changes: finished moves (dragging false) of the nodes being moved. */
export function movesOf(changes: NodeChange[], byId: ReadonlyMap<string, TopoNode>, moving: ReadonlySet<string>): Move[] {
  const out: Move[] = [];
  for (const c of changes) {
    if (c.type !== "position" || c.dragging !== false || !c.position || !moving.has(c.id)) continue;
    const node = byId.get(c.id);
    if (!node || !validTopologyKey(node.key)) continue;
    const parent = node.parent ? byId.get(node.parent) : undefined;
    const p = parent ? parent.key : null;
    if (p !== null && !validTopologyKey(p)) continue;
    out.push({ key: node.key, at: { x: Math.round(c.position.x), y: Math.round(c.position.y), p } });
  }
  return out;
}
