// views/labs/topology/layout.ts
//
// Plain English: where every box of a lab diagram goes (lab topology spec
// §8.1-§8.2). A strict tree (resource group → VNet → subnet → resource) is
// packed bottom-up: a subnet lays its resources in a small grid, a VNet and a
// resource group shelf-pack their children in rows, and the root puts the
// gateway, the Global lane, the resource groups and the Tenant lane side by
// side. Positions are relative to the parent (React Flow's parentId).
//
// The person's saved arrangement wins: a saved { x, y, p } is used while the
// node still sits under the parent key `p`; unsaved siblings are packed below
// the saved ones, so a new resource never lands on a moved one, and every
// container grows to hold its children plus padding.
//
// Pure and deterministic: no clock, no randomness, children sorted by fixed
// rules, so the same graph in any order lays out identically.

import type { TopologyGraph, TopoNode, TopoKind, TopoPropValue } from "@shared/topology/model";
import { isGroupKind } from "@shared/topology/model";
import { KINDS } from "@shared/topology/kinds";
import { SYNTHETIC_KEYS } from "@shared/topology/keys";
import type { TopologyLayout } from "@shared/topology/layout";
import { groupHeaderBits, headerTextWidth, rgChipsFor } from "./words";

export const CARD_W = 200;
export const CARD_H = 84;
export const GAP = 16;
export const PAD = 16;
export const HEADER = 36;
export const SUBNET_HEADER = 28;
export const ROOT_GAP = 48;
export const EMPTY_W = 232;
export const EMPTY_H = 72;
/** Shelf widths: a VNet (or virtual hub) packs to max(widest child, 760); a resource group or lane to max(widest, 1000). */
export const VNET_SHELF = 760;
export const RG_SHELF = 1000;

export interface LaidNode {
  id: string;
  /** Relative to the parent (absolute at the root). */
  x: number;
  y: number;
  w: number;
  h: number;
  parent: string | null;
}

export interface TopologyLayoutResult {
  /** Parents before their children. */
  nodes: LaidNode[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The first IPv4 address in a prop value as a number (for "by address" order); null when there is none. */
export function ipNumber(v: TopoPropValue | undefined): number | null {
  const s = Array.isArray(v) ? v[0] : typeof v === "string" ? v : undefined;
  const m = s?.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/);
  if (!m) return null;
  return ((+m[1]! * 256 + +m[2]!) * 256 + +m[3]!) * 256 + +m[4]!;
}

const byAddress = (prop: string) => (a: TopoNode, b: TopoNode) => {
  const x = ipNumber(a.props[prop]);
  const y = ipNumber(b.props[prop]);
  if (x !== y) return x === null ? 1 : y === null ? -1 : x - y;
  return cmp(a.label, b.label) || cmp(a.id, b.id);
};
const byKind = (a: TopoNode, b: TopoNode) => KINDS[a.kind].order - KINDS[b.kind].order || cmp(a.label, b.label) || cmp(a.id, b.id);

const chipsOf = (n: TopoNode): string[] => {
  const c = n.props.chips;
  return Array.isArray(c) ? c : typeof c === "string" ? [c] : [];
};

/** Root order (spec §8.1): gateway, Global lane, primary RG, secondary RGs, other RGs by name, Tenant lane, anything else. */
function rootRank(n: TopoNode, labId: string): number {
  if (n.key === SYNTHETIC_KEYS.gateway || n.kind === "gateway") return 0;
  if (n.key === SYNTHETIC_KEYS.globalLane) return 1;
  if (n.kind === "resourceGroup") {
    if (n.label.toLowerCase() === `rg-lab-${labId}`.toLowerCase()) return 2;
    if (chipsOf(n).includes("secondary")) return 3;
    return 4;
  }
  if (n.key === SYNTHETIC_KEYS.tenantLane) return 5;
  if (n.kind === "lane") return 5;
  return 6;
}

const headerOf = (k: TopoKind) => (k === "subnet" ? SUBNET_HEADER : HEADER);

interface Box {
  id: string;
  w: number;
  h: number;
  /** Children positions, relative to this box. */
  kids: { box: Box; x: number; y: number }[];
}

/** The container shapes tried, as multiples of the screen's (the first wins a tie). */
const INNER_SHAPES = [1, 0.5, 0.75, 1.5, 2, 3];

/** A header's text never widens its box past this (the rest truncates, with the full text on hover). */
export const HEADER_MAX_W = 520;

/**
 * About how wide a container's header is drawn (name, address, chips), so the
 * box can be at least that wide and its chips are not cut off. An estimate
 * from character counts at the header's type sizes; deterministic.
 */
export function headerWidth(n: TopoNode): number {
  // A resource group's tags fold into "+N tags" rather than widen it (GroupCard: rgChipsFor).
  const bits = groupHeaderBits(n);
  const w = n.kind === "resourceGroup" ? headerTextWidth(n, { sub: bits.sub, chips: rgChipsFor(n, 0) }) : headerTextWidth(n, bits);
  return Math.min(HEADER_MAX_W, w);
}

export interface LayoutOptions {
  /**
   * The shape of the space the diagram is shown in (width / height): the tab,
   * the full screen or the hover. Containers and the top level wrap their
   * children into rows so the whole picture comes close to it, which lets the
   * fit zoom stay readable. Left out: the fixed shelves (760 / 1000) and one
   * row at the top level.
   */
  aspect?: number;
  /**
   * The space itself (canvas pixels), when known: its shape is the aspect,
   * and among packings that all fit at 100% the one closest to its shape wins.
   */
  space?: { w: number; h: number };
}

/** The share of the space React Flow's fit leaves round the picture (fitView padding 0.08 each side). */
const FIT_SLACK = 1.16;

/** Lays out `graph`, using `saved` positions where they still apply. Same graph, saved and space: same layout. */
export function layoutTopology(graph: TopologyGraph, saved: TopologyLayout | null, opts: LayoutOptions = {}): TopologyLayoutResult {
  const space = opts.space && opts.space.w > 0 && opts.space.h > 0 ? opts.space : null;
  const asked = space ? space.w / space.h : opts.aspect;
  const aspect = asked !== undefined && Number.isFinite(asked) && asked > 0 ? asked : null;
  // A packing no taller (in screen terms) than this fits at 100%: more room would not make it bigger.
  const floor = space ? space.h / FIT_SLACK : 0;
  const ids = new Map(graph.nodes.map((n) => [n.id, n]));
  const children = new Map<string | null, TopoNode[]>();
  for (const n of graph.nodes) {
    const p = n.parent && n.parent !== n.id && ids.has(n.parent) && isGroupKind(ids.get(n.parent)!.kind) ? n.parent : null;
    const list = children.get(p);
    if (list) list.push(n);
    else children.set(p, [n]);
  }
  const savedNodes = saved?.nodes ?? {};

  /** Sorts a container's children into packing order. */
  function ordered(parent: TopoNode | null, kids: TopoNode[]): TopoNode[] {
    if (!parent) return [...kids].sort((a, b) => rootRank(a, graph.labId) - rootRank(b, graph.labId) || cmp(a.label, b.label) || cmp(a.id, b.id));
    if (parent.kind === "vnet" || parent.kind === "virtualHub") {
      const subnets = kids.filter((k) => k.kind === "subnet").sort(byAddress("prefix"));
      const rest = kids.filter((k) => k.kind !== "subnet").sort(byKind);
      return [...subnets, ...rest];
    }
    if (parent.kind === "resourceGroup" || parent.kind === "lane") {
      // VNets and hubs by their address (a hub's is its prefix).
      const nets = kids.filter((k) => k.kind === "vnet" || k.kind === "virtualHub");
      nets.sort((a, b) => {
        const x = ipNumber(a.props.addressSpace ?? a.props.prefix);
        const y = ipNumber(b.props.addressSpace ?? b.props.prefix);
        if (x !== y) return x === null ? 1 : y === null ? -1 : x - y;
        return cmp(a.label, b.label) || cmp(a.id, b.id);
      });
      const rest = kids.filter((k) => k.kind !== "vnet" && k.kind !== "virtualHub").sort((a, b) => (isGroupKind(a.kind) === isGroupKind(b.kind) ? byKind(a, b) : isGroupKind(a.kind) ? -1 : 1));
      return [...nets, ...rest];
    }
    return [...kids].sort((a, b) => (isGroupKind(a.kind) === isGroupKind(b.kind) ? byKind(a, b) : isGroupKind(a.kind) ? -1 : 1));
  }

  /** Splits children into saved (still under the same parent key) and unsaved. */
  function split(parentKey: string | null, kids: Box[], nodes: TopoNode[]) {
    const fixed: { box: Box; x: number; y: number }[] = [];
    const free: Box[] = [];
    kids.forEach((box, i) => {
      const s = Object.hasOwn(savedNodes, nodes[i]!.key) ? savedNodes[nodes[i]!.key] : undefined;
      if (s && s.p === parentKey && Number.isFinite(s.x) && Number.isFinite(s.y)) fixed.push({ box, x: s.x, y: s.y });
      else free.push(box);
    });
    return { fixed, free };
  }

  /** The shape every container aims for in this attempt (null: the fixed shelves). */
  let inner: number | null = null;

  function build(n: TopoNode): Box {
    if (!isGroupKind(n.kind)) return { id: n.id, w: CARD_W, h: CARD_H, kids: [] };
    const nodes = ordered(n, children.get(n.id) ?? []);
    const boxes = nodes.map(build);
    const top = headerOf(n.kind);
    const { fixed, free } = split(n.key, boxes, nodes);
    // Saved children are kept, pulled inside the padding and below the header.
    for (const f of fixed) {
      f.x = Math.max(PAD, Math.round(f.x));
      f.y = Math.max(top, Math.round(f.y));
    }
    const startY = fixed.length ? Math.max(...fixed.map((f) => f.y + f.box.h)) + GAP : top;
    const minW = Math.max(EMPTY_W, headerWidth(n));
    const size = (all: { box: Box; x: number; y: number }[]) => ({
      w: Math.max(minW, Math.max(...all.map((k) => k.x + k.box.w)) + PAD),
      h: Math.max(EMPTY_H, Math.max(...all.map((k) => k.y + k.box.h)) + PAD),
    });
    let placed: { box: Box; x: number; y: number }[];
    if (n.kind === "subnet") {
      const cols = Math.min(3, Math.ceil(Math.sqrt(Math.max(1, boxes.length))));
      placed = grid(free, cols, PAD, startY);
      if (inner && free.length > 1) {
        // Any number of columns up to 4: the one whose box comes closest to the screen's shape.
        const tries = Array.from({ length: Math.min(4, free.length) }, (_, i) => grid(free, i + 1, PAD, startY));
        placed = closest(tries, (t) => size([...fixed, ...t]), inner);
      }
    } else {
      const widest = Math.max(0, ...boxes.map((b) => b.w));
      const shelf = Math.max(widest, n.kind === "vnet" || n.kind === "virtualHub" ? VNET_SHELF : RG_SHELF);
      placed = shelfPack(free, shelf, PAD, startY);
      if (inner && free.length > 1) placed = closest(rowWidths(free, GAP).map((wd) => shelfPack(free, Math.max(wd, widest), PAD, startY)), (t) => size([...fixed, ...t]), inner);
    }
    const all = [...fixed, ...placed];
    if (all.length === 0) return { id: n.id, w: minW, h: EMPTY_H, kids: [] };
    const { w, h } = size(all);
    // Kids in packing order, so the output order is stable.
    const order = new Map(boxes.map((b, i) => [b, i]));
    all.sort((a, b) => order.get(a.box)! - order.get(b.box)!);
    return { id: n.id, w, h, kids: all };
  }

  const roots = ordered(null, children.get(null) ?? []);
  const bounds = (all: { box: Box; x: number; y: number }[]) =>
    all.length
      ? { w: Math.max(...all.map((k) => k.x + k.box.w)) - Math.min(0, ...all.map((k) => k.x)), h: Math.max(...all.map((k) => k.y + k.box.h)) - Math.min(0, ...all.map((k) => k.y)) }
      : { w: 0, h: 0 };

  /** The whole picture with every container aiming for `shape`; the top level aims for the screen's. */
  function attempt(shape: number | null) {
    inner = shape;
    const rootBoxes = roots.map(build);
    const { fixed, free } = split(null, rootBoxes, roots);
    for (const f of fixed) {
      f.x = Math.round(f.x);
      f.y = Math.round(f.y);
    }
    const rootTop = fixed.length ? Math.max(...fixed.map((f) => f.y + f.box.h)) + ROOT_GAP : 0;
    let x = 0;
    let placed = free.map((box) => {
      const at = { box, x, y: rootTop };
      x += box.w + ROOT_GAP;
      return at;
    });
    if (aspect && free.length > 1) {
      // Wrap the top level into rows (gateway, Global, groups, Tenant, in order) to come closest to the screen's shape.
      const widest = Math.max(...free.map((b) => b.w));
      placed = closest(rowWidths(free, ROOT_GAP).map((wd) => shelfPack(free, Math.max(wd, widest), 0, rootTop, ROOT_GAP)), (t) => bounds([...fixed, ...t]), aspect, floor);
    }
    const order = new Map(rootBoxes.map((b, i) => [b, i]));
    return [...fixed, ...placed].sort((a, b) => order.get(a.box)! - order.get(b.box)!);
  }

  // With a screen shape, containers try a few shapes of their own around it (a tall group can sit beside a wide one);
  // the fixed shelves are tried last. The picture that fits the screen at the largest zoom wins, the screen's own shape
  // first on a tie.
  const top = aspect ? closest([...INNER_SHAPES.map((f) => attempt(aspect * f)), attempt(null)], bounds, aspect, floor) : attempt(null);

  const out: LaidNode[] = [];
  const walk = (k: { box: Box; x: number; y: number }, parent: string | null) => {
    out.push({ id: k.box.id, x: k.x, y: k.y, w: k.box.w, h: k.box.h, parent });
    for (const c of k.box.kids) walk(c, k.box.id);
  };
  for (const k of top) walk(k, null);
  return { nodes: out };
}

/** Fixed-size cells in `cols` columns, row by row. */
function grid(boxes: Box[], cols: number, x0: number, y0: number) {
  return boxes.map((box, i) => ({ box, x: x0 + (i % cols) * (CARD_W + GAP), y: y0 + Math.floor(i / cols) * (CARD_H + GAP) }));
}

/** Left to right in rows no wider than `width`, each row as tall as its tallest box. */
function shelfPack(boxes: Box[], width: number, x0: number, y0: number, gap = GAP) {
  const out: { box: Box; x: number; y: number }[] = [];
  let x = 0;
  let y = y0;
  let rowH = 0;
  for (const box of boxes) {
    if (x > 0 && x + box.w > width) {
      y += rowH + gap;
      x = 0;
      rowH = 0;
    }
    out.push({ box, x: x0 + x, y });
    x += box.w + gap;
    rowH = Math.max(rowH, box.h);
  }
  return out;
}

/** The row widths worth trying: the first k boxes side by side, for every k (ascending, so ties keep the narrower). */
function rowWidths(boxes: Box[], gap: number): number[] {
  const out: number[] = [];
  let w = 0;
  boxes.forEach((b, i) => {
    w += (i ? gap : 0) + b.w;
    out.push(w);
  });
  return out;
}

/**
 * The packing whose bounds fit a screen of shape `aspect` at the largest zoom:
 * the smallest max(w / aspect, h). The first wins a tie, so the result is
 * deterministic.
 */
function closest<T>(tries: T[], bounds: (t: T) => { w: number; h: number }, aspect: number, floor = 0): T {
  let best = tries[0] as T;
  let score = Infinity;
  let off = Infinity;
  for (const t of tries) {
    const b = bounds(t);
    // Every packing that fits at 100% (at or under `floor`) is as readable as the next: then the one whose shape is
    // closest to the screen's wins.
    const s = Math.max(b.w / aspect, b.h, floor);
    const o = Math.abs(Math.log(b.w / Math.max(1, b.h) / aspect));
    if (s < score - 0.5 || (s <= score + 0.5 && o < off - 0.01)) {
      best = t;
      score = Math.min(score, s);
      off = o;
    }
  }
  return best;
}
