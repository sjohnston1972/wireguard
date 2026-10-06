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

/** Lays out `graph`, using `saved` positions where they still apply. */
export function layoutTopology(graph: TopologyGraph, saved: TopologyLayout | null): TopologyLayoutResult {
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
    let placed: { box: Box; x: number; y: number }[];
    if (n.kind === "subnet") {
      const cols = Math.min(3, Math.ceil(Math.sqrt(Math.max(1, boxes.length))));
      placed = grid(free, cols, PAD, startY);
    } else {
      const widest = Math.max(0, ...boxes.map((b) => b.w));
      const shelf = Math.max(widest, n.kind === "vnet" || n.kind === "virtualHub" ? VNET_SHELF : RG_SHELF);
      placed = shelfPack(free, shelf, PAD, startY);
    }
    const all = [...fixed, ...placed];
    if (all.length === 0) return { id: n.id, w: EMPTY_W, h: EMPTY_H, kids: [] };
    const w = Math.max(EMPTY_W, Math.max(...all.map((k) => k.x + k.box.w)) + PAD);
    const h = Math.max(EMPTY_H, Math.max(...all.map((k) => k.y + k.box.h)) + PAD);
    // Kids in packing order, so the output order is stable.
    const order = new Map(boxes.map((b, i) => [b, i]));
    all.sort((a, b) => order.get(a.box)! - order.get(b.box)!);
    return { id: n.id, w, h, kids: all };
  }

  const roots = ordered(null, children.get(null) ?? []);
  const rootBoxes = roots.map(build);
  const { fixed, free } = split(null, rootBoxes, roots);
  for (const f of fixed) {
    f.x = Math.round(f.x);
    f.y = Math.round(f.y);
  }
  const rootTop = fixed.length ? Math.max(...fixed.map((f) => f.y + f.box.h)) + ROOT_GAP : 0;
  let x = 0;
  const placed = free.map((box) => {
    const at = { box, x, y: rootTop };
    x += box.w + ROOT_GAP;
    return at;
  });
  const order = new Map(rootBoxes.map((b, i) => [b, i]));
  const top = [...fixed, ...placed].sort((a, b) => order.get(a.box)! - order.get(b.box)!);

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
function shelfPack(boxes: Box[], width: number, x0: number, y0: number) {
  const out: { box: Box; x: number; y: number }[] = [];
  let x = 0;
  let y = y0;
  let rowH = 0;
  for (const box of boxes) {
    if (x > 0 && x + box.w > width) {
      y += rowH + GAP;
      x = 0;
      rowH = 0;
    }
    out.push({ box, x: x0 + x, y });
    x += box.w + GAP;
    rowH = Math.max(rowH, box.h);
  }
  return out;
}
