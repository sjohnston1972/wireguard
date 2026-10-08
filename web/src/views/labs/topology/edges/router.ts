// views/labs/topology/edges/router.ts
//
// Plain English: every line of a lab diagram gets a lane of its own (Steven,
// 2026-10-08: "it is in no way clear what lines lead from which element to
// the next"). All the lines are routed together, so they can keep out of
// each other's way:
//
//   1. Sides. Each line picks the sides of its two boxes it leaves and enters
//      by: the shortest way round the cards (a search over a sparse grid of
//      corridors, below), facing sides preferred.
//   2. Ports. A side used by several lines gives each its own point along it,
//      in the order of where the lines go (so they do not cross on leaving),
//      instead of one shared point in the middle.
//   3. Routes. Each line is routed from its port to its port along the grid:
//      straight runs and right angles, never through a card (cards are
//      padded), under a container's header strip only at a cost, along a
//      container's border only at a cost, and never along a stretch or round
//      a corner another line already uses (crossing one is allowed, at a
//      cost). The grid has several lanes in every corridor, so two lines
//      side by side run apart.
//   4. Labels. Each label sits on its own line's longest clear stretch, never
//      on a card, a header or another label.
//
// Pure and deterministic: boxes and edges in (any order), routes out, the same
// every time. Small enough for every lab (tens of boxes); the canvas uses the
// simple per-edge routing (route.ts) while a node is being dragged.

import type { Side } from "./floating";
import { labelSize, type Box, type Pt } from "./labelSpot";

export interface RouterBox extends Box {
  id: string;
  /** A container (resource group, VNet, subnet, hub, lane); a resource card otherwise. */
  group: boolean;
  /** A container's header strip height (0 for a card). */
  head: number;
}

export interface RouterEdge {
  id: string;
  from: string;
  to: string;
  /** The label chip's text (null: no chip). */
  label: string | null;
}

export interface RoutedEdge {
  /** The route's corners, port to port: straight runs at right angles. */
  points: Pt[];
  /** The SVG path (corners rounded). */
  path: string;
  /** The label chip's centre (null: no label). */
  label: Pt | null;
  sourceSide: Side;
  targetSide: Side;
}

/** A label's text as drawn: the label and the connection state's word ("TCP 80→80 · Connected"). */
export function edgeLabelText(d: { label?: string; state?: { word: string }; showLabel: boolean }): string | null {
  if (!d.showLabel) return null;
  const t = [d.label, d.state?.word].filter(Boolean).join(" · ");
  return t || null;
}

/** Clearance kept round every card. */
const MARGIN = 10;
/** How far a line runs straight out of its port before it may turn (the arrowhead sits on this stretch). */
const STUB = 20;
/** The spacing of the lanes in a corridor. */
const LANE = 12;
/** At most this many lanes in one corridor. */
const MAX_LANES = 7;
/** Grid lines closer than this to one already kept are dropped (ports and stubs are always kept). */
const MIN_SEP = 5;
/** Two parallel lines closer than this read as one: a stretch this close beside a drawn line is taken. */
const NEAR = 7;
/** What a turn costs, in pixels of length. */
const BEND = 36;
/** What crossing another line costs. */
const CROSS = 40;
/** A line running inside a header strip costs this many times its length; crossing one costs HEAD_CROSS. */
const HEAD_FACTOR = 5;
const HEAD_CROSS = 120;
/** A line running along a container's border costs this many times its length (it would look like the border). */
const BORDER_FACTOR = 4;
/** A side that faces away from the other end costs this much to leave or enter by; a facing side on the narrower gap's axis, OTHER_AXIS. */
const AWAY = 90;
const OTHER_AXIS = 50;
/** The search gives up past this many steps (a fallback route is drawn instead). */
const MAX_STEPS = 200_000;
/** The corner radius of a drawn route. */
const RADIUS = 8;

const SIDES: Side[] = ["right", "left", "bottom", "top"];
/** Directions: 0 +x, 1 -x, 2 +y, 3 -y. */
const OUT: Record<Side, number> = { right: 0, left: 1, bottom: 2, top: 3 };
const DX = [1, -1, 0, 0];
const DY = [0, 0, 1, -1];

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const centre = (b: Box): Pt => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** The point `t` (0..1) along side `s` of box `b`. */
function sidePoint(b: Box, s: Side, t: number): Pt {
  switch (s) {
    case "top":
      return { x: b.x + b.w * t, y: b.y };
    case "bottom":
      return { x: b.x + b.w * t, y: b.y + b.h };
    case "left":
      return { x: b.x, y: b.y + b.h * t };
    case "right":
      return { x: b.x + b.w, y: b.y + b.h * t };
  }
}
const stubOf = (p: Pt, s: Side): Pt => ({ x: p.x + DX[OUT[s]]! * STUB, y: p.y + DY[OUT[s]]! * STUB });

/** Whether side `s` of `b` faces the point `o` (the line would leave towards it). */
function faces(b: Box, s: Side, o: Pt): boolean {
  switch (s) {
    case "right":
      return o.x >= b.x + b.w;
    case "left":
      return o.x <= b.x;
    case "bottom":
      return o.y >= b.y + b.h;
    case "top":
      return o.y <= b.y;
  }
}

/**
 * What leaving (or entering) `b` by side `s` towards box `o` costs: nothing for the facing side on the axis with the
 * wider gap (as floating.ts picks), a little for the other facing side, AWAY for a side facing away.
 */
function sideCost(b: Box, s: Side, o: Box): number {
  const gapX = Math.max(o.x - (b.x + b.w), b.x - (o.x + o.w));
  const gapY = Math.max(o.y - (b.y + b.h), b.y - (o.y + o.h));
  const cb = centre(b);
  const co = centre(o);
  const across = gapX > 0 || gapY > 0 ? gapX >= gapY : Math.abs(co.x - cb.x) >= Math.abs(co.y - cb.y);
  const best: Side = across ? (co.x >= cb.x ? "right" : "left") : co.y >= cb.y ? "bottom" : "top";
  return s === best ? 0 : faces(b, s, co) ? OTHER_AXIS : AWAY;
}

// ── The grid ──────────────────────────────────────────────────────────

interface Grid {
  xs: number[];
  ys: number[];
  nx: number;
  blocked: Uint8Array;
  xi: Map<number, number>;
  yi: Map<number, number>;
}

/** Grid lines: the kept coordinates first (exact), then the others unless too close to one already kept. */
function lines(keep: number[], rest: number[]): number[] {
  const out = [...new Set(keep)].sort((a, b) => a - b);
  const extra = [...new Set(rest)].sort((a, b) => a - b);
  for (const v of extra) {
    // Binary search for the nearest kept line.
    let lo = 0;
    let hi = out.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (out[mid]! < v) lo = mid + 1;
      else hi = mid;
    }
    const near = Math.min(lo < out.length ? Math.abs(out[lo]! - v) : Infinity, lo > 0 ? Math.abs(out[lo - 1]! - v) : Infinity);
    if (near >= MIN_SEP) out.splice(lo, 0, v);
  }
  return out;
}

/** Lanes in the gaps between consecutive coordinates: centred bundles LANE apart (none inside `skip`). */
function lanes(coords: number[], skip: (v: number) => boolean): number[] {
  const s = [...new Set(coords)].sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1]!;
    const b = s[i]!;
    const g = b - a;
    if (g < 2 * LANE) continue;
    const k = Math.min(MAX_LANES, Math.floor(g / LANE) - 1);
    const mid = (a + b) / 2;
    for (let j = 0; j < k; j++) {
      const v = Math.round((mid + (j - (k - 1) / 2) * LANE) * 2) / 2;
      if (!skip(v)) out.push(v);
    }
  }
  return out;
}

function buildGrid(cards: readonly RouterBox[], groups: readonly RouterBox[], keepX: number[], keepY: number[]): Grid {
  const bx: number[] = [];
  const by: number[] = [];
  for (const c of cards) {
    bx.push(c.x - MARGIN, c.x + c.w + MARGIN);
    by.push(c.y - MARGIN, c.y + c.h + MARGIN);
  }
  const gx: number[] = [];
  const gy: number[] = [];
  for (const g of groups) {
    gx.push(g.x, g.x + g.w);
    gy.push(g.y, g.y + g.h, g.y + g.head);
  }
  const all = [...cards, ...groups];
  const minX = Math.min(...all.map((b) => b.x), ...keepX) - 3 * LANE;
  const maxX = Math.max(...all.map((b) => b.x + b.w), ...keepX) + 3 * LANE;
  const minY = Math.min(...all.map((b) => b.y), ...keepY) - 3 * LANE;
  const maxY = Math.max(...all.map((b) => b.y + b.h), ...keepY) + 3 * LANE;
  const inHead = (y: number) => groups.some((g) => y > g.y && y < g.y + g.head);
  const laneX = lanes([...bx, ...gx, ...keepX, minX, maxX], () => false);
  const laneY = lanes([...by, ...gy, ...keepY, minY, maxY], inHead);
  // Just below each header strip: a line can run under a container's name without hiding behind it.
  const underHead = groups.map((g) => g.y + g.head + LANE / 2);
  const xs = lines(keepX, [...bx, ...laneX, minX, maxX]);
  const ys = lines(keepY, [...by, ...laneY, ...underHead, minY, maxY]);
  const nx = xs.length;
  const blocked = new Uint8Array(nx * ys.length);
  for (const c of cards) {
    const x0 = c.x - MARGIN + 0.5;
    const x1 = c.x + c.w + MARGIN - 0.5;
    const y0 = c.y - MARGIN + 0.5;
    const y1 = c.y + c.h + MARGIN - 0.5;
    for (let j = 0; j < ys.length; j++) {
      const y = ys[j]!;
      if (y <= y0 || y >= y1) continue;
      for (let i = 0; i < nx; i++) {
        const x = xs[i]!;
        if (x > x0 && x < x1) blocked[j * nx + i] = 1;
      }
    }
  }
  return { xs, ys, nx, blocked, xi: new Map(xs.map((v, i) => [v, i])), yi: new Map(ys.map((v, j) => [v, j])) };
}

// ── The search ────────────────────────────────────────────────────────

/** Lines already drawn: grid stretches (by node pair), nodes passed straight through (by axis), corners. */
interface Taken {
  edges: Set<number>;
  h: Uint8Array;
  v: Uint8Array;
  /** Corners and stubs: no other line may pass through these. */
  hard: Uint8Array;
}

interface End {
  /** The stub's grid node. */
  node: number;
  side: Side;
  /** What starting (or ending) here costs. */
  cost: number;
}

/** A small binary heap of [f, seq, state]. */
class Heap {
  private a: number[][] = [];
  push(f: number, seq: number, s: number) {
    const a = this.a;
    a.push([f, seq, s]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]![0]! < f || (a[p]![0] === f && a[p]![1]! < seq)) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): number[] | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        const less = (x: number, y: number) => a[x]![0]! < a[y]![0]! || (a[x]![0] === a[y]![0] && a[x]![1]! < a[y]![1]!);
        if (l < a.length && less(l, m)) m = l;
        if (r < a.length && less(r, m)) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

interface Found {
  /** Grid nodes from the start stub to the end stub. */
  nodes: number[];
  start: End;
  end: End;
  cost: number;
}

function search(grid: Grid, groups: readonly RouterBox[], starts: End[], ends: End[], taken: Taken | null): Found | null {
  const { xs, ys, nx, blocked } = grid;
  const n = xs.length * ys.length;
  const G = new Float64Array(n * 4).fill(Infinity);
  const from = new Int32Array(n * 4).fill(-1);
  const startOf = new Int32Array(n * 4).fill(-1);
  const endAt = new Map<number, number>();
  ends.forEach((e, k) => endAt.set(e.node, k));
  const tx = ends.map((e) => xs[e.node % nx]!);
  const ty = ends.map((e) => ys[Math.floor(e.node / nx)]!);
  const h = (node: number) => {
    const x = xs[node % nx]!;
    const y = ys[Math.floor(node / nx)]!;
    let best = Infinity;
    for (let k = 0; k < tx.length; k++) best = Math.min(best, Math.abs(x - tx[k]!) + Math.abs(y - ty[k]!));
    return best;
  };
  const heap = new Heap();
  let seq = 0;
  const GOAL = -2;
  let bestGoal: { cost: number; state: number; end: number } | null = null;
  starts.forEach((s, k) => {
    const st = s.node * 4 + OUT[s.side];
    if (s.cost < G[st]!) {
      G[st] = s.cost;
      startOf[st] = k;
      heap.push(s.cost + h(s.node), seq++, st);
    }
  });
  const ownStubs = new Set([...starts.map((s) => s.node), ...ends.map((e) => e.node)]);
  let steps = 0;
  for (;;) {
    const top = heap.pop();
    if (!top) break;
    const [f, , st] = top as [number, number, number];
    if (st === GOAL) break;
    if (bestGoal && f >= bestGoal.cost) break;
    if (++steps > MAX_STEPS) return null;
    const g = G[st]!;
    if (f - h(Math.floor(st / 4)) > g + 1e-9) continue; // stale
    const node = Math.floor(st / 4);
    const dir = st % 4;
    // Into a port from its stub.
    const k = endAt.get(node);
    if (k !== undefined) {
      const inward = OUT[ends[k]!.side] ^ 1;
      if (dir !== (inward ^ 1)) {
        const cost = g + ends[k]!.cost + (dir === inward ? 0 : BEND);
        if (!bestGoal || cost < bestGoal.cost) {
          bestGoal = { cost, state: st, end: k };
          heap.push(cost, seq++, GOAL);
        }
      }
    }
    const i = node % nx;
    const j = Math.floor(node / nx);
    for (let d = 0; d < 4; d++) {
      if (d === (dir ^ 1)) continue; // no turning back
      const ni = i + DX[d]!;
      const nj = j + DY[d]!;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ys.length) continue;
      const next = nj * nx + ni;
      if (blocked[next] && !ownStubs.has(next)) continue;
      const turn = d !== dir;
      if (taken) {
        const key = Math.min(node, next) * n + Math.max(node, next);
        if (taken.edges.has(key)) continue;
        if (taken.hard[next] && !ownStubs.has(next)) continue;
        // No turning where another line passes.
        if (turn && (taken.h[node] || taken.v[node]) && !ownStubs.has(node)) continue;
      }
      const x0 = xs[i]!;
      const y0 = ys[j]!;
      const x1 = xs[ni]!;
      const y1 = ys[nj]!;
      const len = Math.abs(x1 - x0) + Math.abs(y1 - y0);
      let factor = 1;
      let extra = turn ? BEND : 0;
      const horizontal = d < 2;
      const lo = horizontal ? Math.min(x0, x1) : Math.min(y0, y1);
      const hi = horizontal ? Math.max(x0, x1) : Math.max(y0, y1);
      for (const gr of groups) {
        if (horizontal) {
          if (hi <= gr.x || lo >= gr.x + gr.w) continue;
          if (y0 > gr.y && y0 < gr.y + gr.head) factor = Math.max(factor, HEAD_FACTOR);
          else if (Math.abs(y0 - gr.y) < 3 || Math.abs(y0 - gr.y - gr.h) < 3) factor = Math.max(factor, BORDER_FACTOR);
        } else {
          if (x0 <= gr.x || x0 >= gr.x + gr.w) {
            if ((Math.abs(x0 - gr.x) < 3 || Math.abs(x0 - gr.x - gr.w) < 3) && hi > gr.y && lo < gr.y + gr.h) factor = Math.max(factor, BORDER_FACTOR);
            continue;
          }
          if (hi > gr.y && lo < gr.y + gr.head) extra += HEAD_CROSS;
        }
      }
      if (taken && (horizontal ? taken.v[next] : taken.h[next])) extra += CROSS;
      const ns = next * 4 + d;
      const cost = g + len * factor + extra;
      if (cost < G[ns]! - 1e-9) {
        G[ns] = cost;
        from[ns] = st;
        startOf[ns] = startOf[st]!;
        heap.push(cost + h(next), seq++, ns);
      }
    }
  }
  if (!bestGoal) return null;
  const nodes: number[] = [];
  let s = bestGoal.state;
  while (s >= 0) {
    nodes.push(Math.floor(s / 4));
    if (from[s]! < 0) break;
    s = from[s]!;
  }
  nodes.reverse();
  return { nodes, start: starts[startOf[bestGoal.state]!]!, end: ends[bestGoal.end]!, cost: bestGoal.cost };
}

// ── Drawing ───────────────────────────────────────────────────────────

/** Drops the middle point of every three in a straight line (and repeats). */
function simplify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-9 && Math.abs(last.y - p.y) < 1e-9) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2]!;
      const b = out[out.length - 1]!;
      if ((Math.abs(a.x - b.x) < 1e-9 && Math.abs(b.x - p.x) < 1e-9) || (Math.abs(a.y - b.y) < 1e-9 && Math.abs(b.y - p.y) < 1e-9)) {
        out[out.length - 1] = p;
        continue;
      }
    }
    out.push(p);
  }
  return out;
}

const fmt = (v: number) => String(Math.round(v * 10) / 10);

/** An SVG path through `pts` with rounded corners. */
export function roundedPath(pts: Pt[]): string {
  if (!pts.length) return "";
  let d = `M${fmt(pts[0]!.x)} ${fmt(pts[0]!.y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1]!;
    const c = pts[i]!;
    const q = pts[i + 1]!;
    const r = Math.min(RADIUS, (Math.abs(c.x - p.x) + Math.abs(c.y - p.y)) / 2, (Math.abs(q.x - c.x) + Math.abs(q.y - c.y)) / 2);
    const toward = (a: Pt, b: Pt) => {
      const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y) || 1;
      return { x: a.x + ((b.x - a.x) / len) * r, y: a.y + ((b.y - a.y) / len) * r };
    };
    const a = toward(c, p);
    const b = toward(c, q);
    d += ` L${fmt(a.x)} ${fmt(a.y)} Q${fmt(c.x)} ${fmt(c.y)} ${fmt(b.x)} ${fmt(b.y)}`;
  }
  const last = pts[pts.length - 1]!;
  d += ` L${fmt(last.x)} ${fmt(last.y)}`;
  return d;
}

/** The plain route between two ports when the search finds none: out, across the middle, in. */
function plainRoute(s: Pt, ss: Side, t: Pt, ts: Side): Pt[] {
  const a = stubOf(s, ss);
  const b = stubOf(t, ts);
  const across = ss === "left" || ss === "right";
  const mid = across ? [{ x: (a.x + b.x) / 2, y: a.y }, { x: (a.x + b.x) / 2, y: b.y }] : [{ x: a.x, y: (a.y + b.y) / 2 }, { x: b.x, y: (a.y + b.y) / 2 }];
  return simplify([s, a, ...mid, b, t]);
}

// ── Labels ────────────────────────────────────────────────────────────

function area(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
const segHits = (a: Pt, b: Pt, box: Box) => Math.max(a.x, b.x) > box.x && Math.min(a.x, b.x) < box.x + box.w && Math.max(a.y, b.y) > box.y && Math.min(a.y, b.y) < box.y + box.h;

function placeLabel(pts: Pt[], text: string, solid: readonly Box[], placed: readonly Box[], others: readonly Pt[][]): { at: Pt; hard: number } {
  const size = labelSize(text);
  const segs = pts.slice(1).map((b, i) => ({ a: pts[i]!, b, i, len: Math.abs(b.x - pts[i]!.x) + Math.abs(b.y - pts[i]!.y) }));
  const total = segs.reduce((s, x) => s + x.len, 0);
  let best: Pt = { x: (pts[0]!.x + pts[pts.length - 1]!.x) / 2, y: (pts[0]!.y + pts[pts.length - 1]!.y) / 2 };
  let bestHard = Infinity;
  let bestSoft = Infinity;
  let walked = 0;
  for (const s of segs) {
    const stub = s.i === 0 || s.i === segs.length - 1;
    // The middle and the quarters first, then every few pixels (the soft score prefers the middle of the whole line).
    const steps = Math.max(1, Math.floor(s.len / 6));
    const ts = [0.5, 0.35, 0.65, 0.2, 0.8, ...Array.from({ length: steps + 1 }, (_, i) => i / steps)];
    for (const t of ts) {
      const p = { x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t };
      const box = { x: p.x - size.w / 2 - 3, y: p.y - size.h / 2 - 3, w: size.w + 6, h: size.h + 6 };
      let hard = 0;
      for (const o of solid) hard += area(box, o);
      for (const o of placed) hard += area(box, o);
      let soft = Math.abs(walked + s.len * t - total / 2) * 0.5 + (stub ? 400 : 0);
      // Along its own line: a short stretch the chip overhangs reads less clearly.
      const along = s.a.x === s.b.x ? size.h : size.w;
      if (s.len < along + 8) soft += 150;
      for (const o of others) for (let i = 1; i < o.length; i++) if (segHits(o[i - 1]!, o[i]!, box)) soft += 300;
      if (hard < bestHard - 1e-6 || (Math.abs(hard - bestHard) <= 1e-6 && soft < bestSoft - 1e-6)) {
        best = p;
        bestHard = hard;
        bestSoft = soft;
      }
    }
    walked += s.len;
  }
  return { at: best, hard: bestHard };
}

// ── All together ──────────────────────────────────────────────────────

/** Routes every edge between the boxes (see the top of the file). Edges to a box not given are left out. */
export function routeAll({ boxes, edges }: { boxes: readonly RouterBox[]; edges: readonly RouterEdge[] }): Map<string, RoutedEdge> {
  const out = new Map<string, RoutedEdge>();
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const sorted = [...boxes].sort((a, b) => cmp(a.id, b.id));
  const cards = sorted.filter((b) => !b.group);
  const groups = sorted.filter((b) => b.group);
  const list = edges.filter((e) => e.from !== e.to && byId.has(e.from) && byId.has(e.to)).sort((a, b) => cmp(a.id, b.id));
  if (!list.length) return out;

  // 1. Sides: the cheapest way round the cards from the middle of any side to the middle of any side.
  const mids = new Map<string, { p: Pt; stub: Pt }>();
  const keepX: number[] = [];
  const keepY: number[] = [];
  for (const b of new Set(list.flatMap((e) => [e.from, e.to]))) {
    for (const s of SIDES) {
      const p = sidePoint(byId.get(b)!, s, 0.5);
      const stub = stubOf(p, s);
      mids.set(`${b}|${s}`, { p, stub });
      keepX.push(stub.x, p.x);
      keepY.push(stub.y, p.y);
    }
  }
  const first = buildGrid(cards, groups, keepX, keepY);
  const nodeAt = (g: Grid, p: Pt) => (g.yi.get(p.y) ?? -1) * g.nx + (g.xi.get(p.x) ?? -1);
  const chosen = new Map<string, { ss: Side; ts: Side; cost: number }>();
  for (const e of list) {
    const a = byId.get(e.from)!;
    const b = byId.get(e.to)!;
    const starts = SIDES.map((s) => ({ node: nodeAt(first, mids.get(`${e.from}|${s}`)!.stub), side: s, cost: STUB + sideCost(a, s, b) }));
    const ends = SIDES.map((s) => ({ node: nodeAt(first, mids.get(`${e.to}|${s}`)!.stub), side: s, cost: STUB + sideCost(b, s, a) }));
    const found = search(first, groups, starts, ends, null);
    if (found) chosen.set(e.id, { ss: found.start.side, ts: found.end.side, cost: found.cost });
    else {
      // Facing sides on the longer axis.
      const ca = centre(a);
      const cb = centre(b);
      const across = Math.abs(cb.x - ca.x) >= Math.abs(cb.y - ca.y);
      chosen.set(e.id, across ? { ss: cb.x >= ca.x ? "right" : "left", ts: cb.x >= ca.x ? "left" : "right", cost: Infinity } : { ss: cb.y >= ca.y ? "bottom" : "top", ts: cb.y >= ca.y ? "top" : "bottom", cost: Infinity });
    }
  }

  // 2. Ports: each line its own point along its side, in the order of where the lines go.
  const perSide = new Map<string, { edge: string; end: "s" | "t"; other: Pt }[]>();
  for (const e of list) {
    const c = chosen.get(e.id)!;
    for (const [box, side, end, other] of [
      [e.from, c.ss, "s", e.to],
      [e.to, c.ts, "t", e.from],
    ] as const) {
      const k = `${box}|${side}`;
      const l = perSide.get(k) ?? [];
      l.push({ edge: e.id, end, other: centre(byId.get(other)!) });
      perSide.set(k, l);
    }
  }
  const ports = new Map<string, Pt>();
  for (const [k, l] of perSide) {
    const [box, side] = k.split("|") as [string, Side];
    const b = byId.get(box)!;
    const vertical = side === "left" || side === "right";
    l.sort((p, q) => (vertical ? p.other.y - q.other.y || p.other.x - q.other.x : p.other.x - q.other.x || p.other.y - q.other.y) || cmp(p.edge, q.edge) || cmp(p.end, q.end));
    const length = vertical ? b.h : b.w;
    // Cards spread their ports along the side; a container keeps them near the middle of its (long) side.
    const step = Math.min(length / (l.length + 1), b.group ? 28 : Infinity);
    l.forEach((x, i) => {
      const off = length / 2 + (i - (l.length - 1) / 2) * step;
      ports.set(`${x.edge}|${x.end}`, sidePoint(b, side, off / length));
    });
  }

  // 3. Routes, shortest first, each keeping off the ones before it.
  const kx: number[] = [];
  const ky: number[] = [];
  for (const e of list) {
    const c = chosen.get(e.id)!;
    for (const [p, s] of [
      [ports.get(`${e.id}|s`)!, c.ss],
      [ports.get(`${e.id}|t`)!, c.ts],
    ] as const) {
      const st = stubOf(p, s);
      kx.push(p.x, st.x);
      ky.push(p.y, st.y);
    }
  }
  const grid = buildGrid(cards, groups, kx, ky);
  const n = grid.xs.length * grid.ys.length;
  const taken: Taken = { edges: new Set(), h: new Uint8Array(n), v: new Uint8Array(n), hard: new Uint8Array(n) };
  // Every line's stretch from its port to its stub is its own: no other line passes through it (a container's port is
  // in the open, not inside a card's clearance).
  /** Takes the stretch between two neighbouring grid nodes, and the stretches a few pixels beside it (they would read as the same line). */
  const take = (a: number, b: number) => {
    const key = (u: number, v: number) => Math.min(u, v) * n + Math.max(u, v);
    taken.edges.add(key(a, b));
    const [ia, ja, ib, jb] = [a % grid.nx, Math.floor(a / grid.nx), b % grid.nx, Math.floor(b / grid.nx)];
    const horizontal = ja === jb;
    (horizontal ? taken.h : taken.v)[a] = 1;
    (horizontal ? taken.h : taken.v)[b] = 1;
    if (horizontal) {
      for (let j = 0; j < grid.ys.length; j++) if (j !== ja && Math.abs(grid.ys[j]! - grid.ys[ja]!) < NEAR) taken.edges.add(key(j * grid.nx + ia, j * grid.nx + ib));
    } else {
      for (let i = 0; i < grid.nx; i++) if (i !== ia && Math.abs(grid.xs[i]! - grid.xs[ia]!) < NEAR) taken.edges.add(key(ja * grid.nx + i, jb * grid.nx + i));
    }
  };
  const reserve = (p: Pt, q: Pt) => {
    const [i0, i1] = [grid.xi.get(p.x)!, grid.xi.get(q.x)!].sort((u, v) => u - v);
    const [j0, j1] = [grid.yi.get(p.y)!, grid.yi.get(q.y)!].sort((u, v) => u - v);
    for (let i = i0!; i <= i1!; i++) for (let j = j0!; j <= j1!; j++) taken.hard[j * grid.nx + i] = 1;
    if (i0 === i1) for (let j = j0!; j < j1!; j++) take(j * grid.nx + i0!, (j + 1) * grid.nx + i0!);
    else for (let i = i0!; i < i1!; i++) take(j0! * grid.nx + i, j0! * grid.nx + i + 1);
  };
  for (const e of list) {
    const c = chosen.get(e.id)!;
    const sp = ports.get(`${e.id}|s`)!;
    const tp = ports.get(`${e.id}|t`)!;
    reserve(sp, stubOf(sp, c.ss));
    reserve(tp, stubOf(tp, c.ts));
  }
  const order = [...list].sort((a, b) => chosen.get(a.id)!.cost - chosen.get(b.id)!.cost || cmp(a.id, b.id));
  const routes = new Map<string, Pt[]>();
  for (const e of order) {
    const c = chosen.get(e.id)!;
    const sp = ports.get(`${e.id}|s`)!;
    const tp = ports.get(`${e.id}|t`)!;
    const start = { node: nodeAt(grid, stubOf(sp, c.ss)), side: c.ss, cost: STUB };
    const end = { node: nodeAt(grid, stubOf(tp, c.ts)), side: c.ts, cost: STUB };
    const found = search(grid, groups, [start], [end], taken) ?? search(grid, groups, [start], [end], null);
    if (!found) {
      routes.set(e.id, plainRoute(sp, c.ss, tp, c.ts));
      continue;
    }
    const nodes = found.nodes;
    for (let i = 1; i < nodes.length; i++) take(nodes[i - 1]!, nodes[i]!);
    const pts = nodes.map((k) => ({ x: grid.xs[k % grid.nx]!, y: grid.ys[Math.floor(k / grid.nx)]! }));
    const simple = simplify([sp, ...pts, tp]);
    // Corners are hard: no other line passes through them.
    for (const p of simple.slice(1, -1)) {
      const k = nodeAt(grid, p);
      if (k >= 0) taken.hard[k] = 1;
    }
    routes.set(e.id, simple);
  }

  // 4. Labels, shortest line first (it has the least room), each clear of the cards, the headers and the labels before it.
  const solid: Box[] = [...cards, ...groups.map((g) => ({ x: g.x, y: g.y, w: g.w, h: g.head }))];
  const lengthOf = (pts: Pt[]) => pts.slice(1).reduce((s, p, i) => s + Math.abs(p.x - pts[i]!.x) + Math.abs(p.y - pts[i]!.y), 0);
  const byLength = [...order].sort((a, b) => lengthOf(routes.get(a.id)!) - lengthOf(routes.get(b.id)!) || cmp(a.id, b.id));
  const chips = new Map<string, Pt>();
  const boxOf = (id: string, at: Pt): Box => {
    const size = labelSize(list.find((e) => e.id === id)!.label!);
    return { x: at.x - size.w / 2 - 2, y: at.y - size.h / 2 - 2, w: size.w + 4, h: size.h + 4 };
  };
  const othersOf = (id: string) => order.filter((o) => o.id !== id).map((o) => routes.get(o.id)!);
  const placedBut = (...skip: string[]) => [...chips].filter(([k]) => !skip.includes(k)).map(([k, at]) => boxOf(k, at));
  for (const e of byLength) {
    if (!e.label) continue;
    const pts = routes.get(e.id)!;
    const got = placeLabel(pts, e.label, solid, placedBut(), othersOf(e.id));
    chips.set(e.id, got.at);
    if (got.hard <= 0) continue;
    // No clear spot: move a label in the way to another clear spot on its own line, if it has one.
    const mine = boxOf(e.id, got.at);
    for (const [k, at] of [...chips]) {
      if (k === e.id || area(mine, boxOf(k, at)) <= 0) continue;
      const moved = placeLabel(routes.get(k)!, list.find((x) => x.id === k)!.label!, [...solid, mine], placedBut(k, e.id), othersOf(k));
      if (moved.hard <= 0) chips.set(k, moved.at);
    }
  }
  for (const e of order) {
    const pts = routes.get(e.id)!;
    const c = chosen.get(e.id)!;
    out.set(e.id, { points: pts, path: roundedPath(pts), label: chips.get(e.id) ?? null, sourceSide: c.ss, targetSide: c.ts });
  }
  return new Map([...out].sort((a, b) => cmp(a[0], b[0])));
}
