// Which sides an edge uses (route.ts): the nearest facing sides, unless that line would pass under another card or
// run under a container's header, when the pair of sides that avoids them wins.
import { describe, expect, it } from "vitest";
import { getSmoothStepPath, Position } from "@xyflow/react";
import { floatingEnds } from "./floating";
import { pathPoints } from "./labelSpot";
import { routeEdge, type Obstacle } from "./route";

const card = (id: string, x: number, y: number): Obstacle => ({ id, x, y, w: 200, h: 84, head: false });
const under = (path: string, o: Obstacle) => {
  const pts = pathPoints(path);
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1]!, pts[i]!];
    if (Math.max(a.x, b.x) > o.x + 2 && Math.min(a.x, b.x) < o.x + o.w - 2 && Math.max(a.y, b.y) > o.y + 2 && Math.min(a.y, b.y) < o.y + o.h - 2) return true;
  }
  return false;
};

describe("routeEdge", () => {
  it("the nearest facing sides when nothing is in the way", () => {
    const a = card("a", 0, 0);
    const b = card("b", 400, 20);
    const e = floatingEnds(a, b);
    const [d] = getSmoothStepPath({ sourceX: e.sx, sourceY: e.sy, sourcePosition: Position.Right, targetX: e.tx, targetY: e.ty, targetPosition: Position.Left, borderRadius: 10, offset: 18 });
    expect(routeEdge(a, b, [a, b], "a", "b").path).toBe(d);
  });

  it("goes round a card that sits between the two (it would look as if the line started there)", () => {
    // lb-uks below, vm-nva and lb-gw above it, vm-web1 on top: one column.
    const src = card("lb-uks", 0, 600);
    const mid = card("vm-nva", 20, 420);
    const mid2 = card("lb-gw", 20, 300);
    const dst = card("vm-web1", 20, 100);
    const obstacles = [src, mid, mid2, dst];
    expect(under(routeEdge(src, dst, [], "lb-uks", "vm-web1").path, mid)).toBe(true);
    const r = routeEdge(src, dst, obstacles, "lb-uks", "vm-web1");
    expect(under(r.path, mid)).toBe(false);
    expect(under(r.path, mid2)).toBe(false);
  });

  it("leaves a subnet by a side rather than under its header strip when it can", () => {
    const src = card("vm", 116, 128); // in a subnet whose header runs 100-128
    const head: Obstacle = { id: "snet", x: 100, y: 100, w: 232, h: 28, head: true };
    const dst = card("lb", 160, -200);
    expect(under(routeEdge(src, dst, [], "vm", "lb").path, head)).toBe(true);
    expect(under(routeEdge(src, dst, [src, dst, head], "vm", "lb").path, head)).toBe(false);
  });
});
