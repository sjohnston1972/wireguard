// views/labs/topology/edges/route.ts
//
// Plain English: which sides of its two cards an edge leaves and enters
// (lab topology spec §9.2). The nearest facing sides first (floating.ts); but
// edges run under the nodes, so a line that passes under a third card looks
// as if it starts or ends there, and one that leaves through the top of a
// subnet runs under its header. When the nearest sides would do either, every
// other pair of sides is tried: a line under no card wins if there is one,
// and headers are weighed against length (a header is worth a short detour),
// the nearest sides on a tie. Pure: the boxes in, the path and its middle out.

import { getSmoothStepPath, Position } from "@xyflow/react";
import { floatingEnds, type Bounds, type FloatingEnds, type Side } from "./floating";
import { pathPoints, type Box } from "./labelSpot";

export interface Obstacle extends Box {
  /** The node: a card's own id, or the container whose header strip this is. */
  id: string;
  /** A container's header strip (a card otherwise). */
  head: boolean;
}

const SIDES: Side[] = ["right", "left", "bottom", "top"];
const POS: Record<Side, Position> = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left };

const point = (b: Bounds, s: Side) =>
  s === "top" ? { x: b.x + b.w / 2, y: b.y } : s === "bottom" ? { x: b.x + b.w / 2, y: b.y + b.h } : s === "left" ? { x: b.x, y: b.y + b.h / 2 } : { x: b.x + b.w, y: b.y + b.h / 2 };

function endsFor(a: Bounds, b: Bounds, sourceSide: Side, targetSide: Side): FloatingEnds {
  const s = point(a, sourceSide);
  const t = point(b, targetSide);
  return { sx: s.x, sy: s.y, tx: t.x, ty: t.y, sourceSide, targetSide };
}

function pathOf(e: FloatingEnds): [string, number, number] {
  const [d, lx, ly] = getSmoothStepPath({ sourceX: e.sx, sourceY: e.sy, sourcePosition: POS[e.sourceSide], targetX: e.tx, targetY: e.ty, targetPosition: POS[e.targetSide], borderRadius: 10, offset: 18 });
  return [d, lx, ly];
}

/** What a path costs: cards it passes under, headers it runs under, and its length. */
function cost(d: string, obstacles: readonly Obstacle[], skip: ReadonlySet<string>): { cards: number; heads: number; length: number } {
  const pts = pathPoints(d);
  let cards = 0;
  let heads = 0;
  let length = 0;
  const crossed = new Set<Obstacle>();
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    length += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    const x0 = Math.min(a.x, b.x);
    const x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    const y1 = Math.max(a.y, b.y);
    for (const o of obstacles) {
      if (crossed.has(o) || (!o.head && skip.has(o.id))) continue;
      // Inside by more than 2px (a line along a border does not count).
      if (x1 > o.x + 2 && x0 < o.x + o.w - 2 && y1 > o.y + 2 && y0 < o.y + o.h - 2) crossed.add(o);
    }
  }
  for (const o of crossed) if (o.head) heads++;
  else cards++;
  return { cards, heads, length };
}

/**
 * Passing under a card misleads (the line seems to start or end there): never, if any route avoids it. Running under
 * a header strip only hides a stretch of line, so it is worth a detour of up to HEAD_DETOUR, no more.
 */
const HEAD_DETOUR = 160;
const score = (c: { cards: number; heads: number; length: number }) => c.cards * 100_000 + c.heads * HEAD_DETOUR + c.length;
const worse = (a: { cards: number; heads: number; length: number }, b: { cards: number; heads: number; length: number }) => score(a) > score(b) + 1;

/** The edge from `a` (card `source`) to `b` (card `target`): its path and the path's middle. */
export function routeEdge(a: Bounds, b: Bounds, obstacles: readonly Obstacle[], source: string, target: string): { path: string; labelX: number; labelY: number } {
  const skip = new Set([source, target]);
  const near = floatingEnds(a, b);
  let [path, labelX, labelY] = pathOf(near);
  let best = cost(path, obstacles, skip);
  if (best.cards === 0 && best.heads === 0) return { path, labelX, labelY };
  for (const ss of SIDES)
    for (const ts of SIDES) {
      if (ss === near.sourceSide && ts === near.targetSide) continue;
      const [d, lx, ly] = pathOf(endsFor(a, b, ss, ts));
      const c = cost(d, obstacles, skip);
      if (worse(best, c)) {
        best = c;
        [path, labelX, labelY] = [d, lx, ly];
      }
    }
  return { path, labelX, labelY };
}
