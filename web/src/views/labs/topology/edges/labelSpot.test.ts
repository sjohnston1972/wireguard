// Where an edge's label sits (labelSpot.ts): on its line, clear of the cards and the containers' header strips.
import { describe, expect, it } from "vitest";
import { getSmoothStepPath, Position } from "@xyflow/react";
import { labelSize, labelSpot, pathPoints } from "./labelSpot";

describe("pathPoints", () => {
  it("reads the corners of a smoothstep path", () => {
    const [d] = getSmoothStepPath({ sourceX: 0, sourceY: 0, sourcePosition: Position.Bottom, targetX: 200, targetY: 300, targetPosition: Position.Top, borderRadius: 10, offset: 18 });
    const pts = pathPoints(d);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts.at(-1)).toEqual({ x: 200, y: 300 });
    expect(pts.length).toBeGreaterThanOrEqual(4);
  });
});

describe("labelSpot", () => {
  const [d, cx, cy] = getSmoothStepPath({ sourceX: 0, sourceY: 0, sourcePosition: Position.Bottom, targetX: 0, targetY: 400, targetPosition: Position.Top, borderRadius: 10, offset: 18 });
  const size = labelSize("chain");

  it("the path's middle when nothing is in the way", () => {
    expect(labelSpot(d, { x: cx, y: cy }, size, [])).toEqual({ x: cx, y: cy });
  });

  it("moves along the line, off a card the line passes under", () => {
    const card = { x: -100, y: 150, w: 200, h: 100 };
    const at = labelSpot(d, { x: cx, y: cy }, size, [card]);
    expect(at.x).toBe(0);
    const clear = at.y + size.h / 2 < card.y || at.y - size.h / 2 > card.y + card.h;
    expect(clear).toBe(true);
  });

  it("stays in the middle when every spot is covered (the label still shows)", () => {
    expect(labelSpot(d, { x: cx, y: cy }, size, [{ x: -500, y: -500, w: 1000, h: 1000 }])).toEqual({ x: cx, y: cy });
  });

  it("with no clear spot, the spot that covers least", () => {
    // Cards above and below the middle, a narrow gap between them at y 300: the label goes into the gap.
    const at = labelSpot(d, { x: cx, y: cy }, size, [{ x: -100, y: 40, w: 200, h: 248 }, { x: -100, y: 312, w: 200, h: 80 }]);
    expect(at.y).toBeGreaterThan(280);
    expect(at.y).toBeLessThan(320);
  });

  it("a label of several lines is as tall as its lines", () => {
    expect(labelSize("TCP 80→80\nTCP 8081-8090→8080").h).toBeGreaterThan(labelSize("TCP 80→80").h);
    expect(labelSize("TCP 8081-8090→8080").w).toBeGreaterThan(labelSize("chain").w);
  });
});
