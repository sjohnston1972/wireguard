// views/labs/topology/edges/labelSpot.ts
//
// Plain English: where an edge's label chip sits. Labels are drawn above
// everything (so a container never hides one), which means a label at the
// middle of its line can land on a card the line passes under, or on a
// container's header. So the middle is tried first, then other spots along
// the line's straight runs (the longest first), and the first spot clear of
// every card and header strip wins; if none is clear, the middle. Pure.

export interface Pt {
  x: number;
  y: number;
}
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** About how big a label chip is drawn (10.5px semibold, 7px padding, one line per "\n"). */
export function labelSize(text: string): { w: number; h: number } {
  const lines = text.split("\n");
  return { w: Math.max(...lines.map((l) => l.length)) * 6.2 + 18, h: lines.length * 14 + 6 };
}

/** The end points of an SVG path's straight runs and curves (M, L and Q commands), in order. */
export function pathPoints(d: string): Pt[] {
  const out: Pt[] = [];
  for (const m of d.matchAll(/([MLQ])([^MLQ]*)/g)) {
    const n = (m[2]!.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/gi) ?? []).map(Number);
    if (n.length >= 2) out.push({ x: n[n.length - 2]!, y: n[n.length - 1]! });
  }
  return out;
}

/** How much of the obstacles a label at `at` would cover (with a 2px margin). */
function covered(at: Pt, size: { w: number; h: number }, obstacles: readonly Box[]): number {
  let area = 0;
  for (const b of obstacles) {
    const w = Math.min(at.x + size.w / 2 + 2, b.x + b.w) - Math.max(at.x - size.w / 2 - 2, b.x);
    const h = Math.min(at.y + size.h / 2 + 2, b.y + b.h) - Math.max(at.y - size.h / 2 - 2, b.y);
    if (w > 0 && h > 0) area += w * h;
  }
  return area;
}

/** The first spot on the line (`d`, middle `center`) where a label of `size` covers no obstacle; if none, the least covered (the middle on a tie). */
export function labelSpot(d: string, center: Pt, size: { w: number; h: number }, obstacles: readonly Box[]): Pt {
  let best = center;
  let least = covered(center, size, obstacles);
  if (least === 0) return center;
  const pts = pathPoints(d);
  const runs: { a: Pt; b: Pt; len: number }[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len >= 24) runs.push({ a, b, len });
  }
  runs.sort((p, q) => q.len - p.len);
  for (const r of runs)
    for (const t of [0.5, 0.25, 0.75, 0.12, 0.88]) {
      const p = { x: r.a.x + (r.b.x - r.a.x) * t, y: r.a.y + (r.b.y - r.a.y) * t };
      const c = covered(p, size, obstacles);
      if (c === 0) return p;
      if (c < least - 1) {
        best = p;
        least = c;
      }
    }
  return best;
}
