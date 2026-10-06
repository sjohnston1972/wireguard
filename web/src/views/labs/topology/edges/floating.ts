// views/labs/topology/edges/floating.ts
//
// Plain English: where an edge leaves and enters its two boxes (lab topology
// spec §9.2, "floating edges"): from the middle of the side of one box that
// faces the other, to the middle of the facing side of the other. Pure, from
// the boxes' absolute bounds, so it follows a node as it is dragged.

export type Side = "top" | "right" | "bottom" | "left";

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FloatingEnds {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  sourceSide: Side;
  targetSide: Side;
}

const point = (b: Bounds, s: Side) => {
  switch (s) {
    case "top":
      return { x: b.x + b.w / 2, y: b.y };
    case "bottom":
      return { x: b.x + b.w / 2, y: b.y + b.h };
    case "left":
      return { x: b.x, y: b.y + b.h / 2 };
    case "right":
      return { x: b.x + b.w, y: b.y + b.h / 2 };
  }
};

/** The nearest facing sides of `a` (source) and `b` (target), and the points where the edge meets them. */
export function floatingEnds(a: Bounds, b: Bounds): FloatingEnds {
  // The gap between the boxes along each axis (negative when they overlap on it).
  const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  const acx = a.x + a.w / 2;
  const acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2;
  const bcy = b.y + b.h / 2;
  let sourceSide: Side;
  let targetSide: Side;
  // Side by side when they are further apart across than up and down (ties go across).
  const across = gapX > 0 || gapY > 0 ? gapX >= gapY : Math.abs(bcx - acx) >= Math.abs(bcy - acy);
  if (across) {
    sourceSide = bcx >= acx ? "right" : "left";
    targetSide = bcx >= acx ? "left" : "right";
  } else {
    sourceSide = bcy >= acy ? "bottom" : "top";
    targetSide = bcy >= acy ? "top" : "bottom";
  }
  const s = point(a, sourceSide);
  const t = point(b, targetSide);
  return { sx: s.x, sy: s.y, tx: t.x, ty: t.y, sourceSide, targetSide };
}
