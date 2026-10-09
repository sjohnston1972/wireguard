// views/labs/topology/layout.ts
//
// Plain English: where every box of a lab diagram goes (lab topology spec
// §8.1-§8.2). A strict tree (resource group → VNet → subnet → resource) is
// packed bottom-up: a subnet lays its resources in a small grid (or in flow
// columns), a VNet and a resource group shelf-pack their children in rows,
// and the root puts the gateway, the Global lane, the resource groups and the
// Tenant lane side by side. Positions are relative to the parent (React
// Flow's parentId).
//
// Generous room (Steven, 2026-10-08): cards sit well apart, containers have
// roomy padding and space under their headers, and sibling containers leave a
// corridor between them, so every line gets a lane of its own (the router,
// edges/router.ts, uses them). Children are ordered by the traffic's flow
// (flowRanks): sources such as Front Door, application gateways, load
// balancers, firewalls and VPN gateways come before the VMs, apps and
// databases they feed, so lines run one way; a subnet holding both lays them
// out in flow columns, sources first.
//
// The person's saved arrangement wins: a saved { x, y, p } is used while the
// node still sits under the parent key `p`; unsaved siblings are packed below
// the saved ones, so a new resource never lands on a moved one, and every
// container grows to hold its children plus padding.
//
// One arrangement everywhere (2026-10-09): the packing aims for one fixed
// shape (LAYOUT_ASPECT, 9:5), never the shape or size of the space it is
// shown in, so the dialog's tab, the full screen, the pop-out and the mini
// draw the same picture; only the fitted zoom and pan differ.
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
/** Between two cards side by side, and one above the other: room for several lines and their labels. */
export const CARD_GAP_X = 120;
export const CARD_GAP_Y = 96;
/** Between sibling containers (or a container and a card): a corridor for lines. */
export const GAP = 96;
/** A container's padding round its children. */
export const PAD = 32;
/** The space between a container's header strip and its first row of children. */
export const HEAD_GAP = 20;
export const HEADER = 36;
export const SUBNET_HEADER = 28;
export const ROOT_GAP = 120;
export const EMPTY_W = 232;
export const EMPTY_H = 72;
/**
 * How far in a saved position is pulled: the padding before 2026-10-08, so a layout saved with the old spacing stays
 * exactly as saved (Reset layout gets the new spacing).
 */
export const SAVED_PAD = 16;
/** Shelf widths: a VNet (or virtual hub) packs to max(widest child, 960); a resource group or lane to max(widest, 1280). */
export const VNET_SHELF = 960;
export const RG_SHELF = 1280;
/** A flow column (or row) in a subnet holds at most this many cards before it wraps into another. */
const FLOW_RUN = 4;

/** The gaps a layout uses. */
export interface Spacing {
  cardX: number;
  cardY: number;
  gap: number;
  pad: number;
  headGap: number;
  rootGap: number;
}
/** The one spacing every layout uses: generous, so several lines and their labels fit between two cards. */
export const SPACING: Spacing = { cardX: CARD_GAP_X, cardY: CARD_GAP_Y, gap: GAP, pad: PAD, headGap: HEAD_GAP, rootGap: ROOT_GAP };
const S = SPACING;

/**
 * The one shape (width / height) every diagram is packed for, wherever it is shown (Steven, 2026-10-09: "toggling to
 * full screen seems to change the layout"). The dialog's Diagram tab, the full screen, the pop-out window and the
 * Overview mini all draw the same arrangement for the same graph and saved positions; only the fit's zoom and pan
 * differ. 9:5 is the lab dialog's Diagram tab's shape, the smallest common view, and measured over every planned lab
 * it reads best there while the wider full screen (about 2.4) and the 2:1 mini still zoom in to fill (fitView).
 */
export const LAYOUT_ASPECT = 1.8;

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

/** Traffic sources by their kind: the edge of the picture (0), the boxes in the middle (1), everything else (2). */
const TIER: Partial<Record<TopoKind, number>> = {
  frontDoor: 0,
  trafficManager: 0,
  appGateway: 1,
  loadBalancer: 1,
  firewall: 1,
  vpnGateway: 1,
  natGateway: 1,
  routeServer: 1,
  bastion: 1,
  privateLinkService: 1,
  privateEndpoint: 1,
  dnsRuleset: 1,
  eventGrid: 1,
};
const tierOf = (k: TopoKind) => TIER[k] ?? 2;

/**
 * Where each resource sits in the traffic's flow: 0 for a source (nothing sends it traffic), otherwise one more than
 * the furthest resource before it (the longest path along traffic edges between resource cards). Cycles (a load
 * balancer rule and its outbound return) break at the edge back to a resource already on the path, walking from the
 * sources first, then by kind (Front Door, then the gateways and balancers, then the rest), label and id. Resources
 * with no traffic edge have no rank. Deterministic: the same graph in any order gives the same ranks.
 */
export function flowRanks(graph: TopologyGraph): Map<string, number> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const asset = (id: string) => byId.has(id) && !isGroupKind(byId.get(id)!.kind);
  const order = (a: string, b: string) => {
    const x = byId.get(a)!;
    const y = byId.get(b)!;
    return tierOf(x.kind) - tierOf(y.kind) || KINDS[x.kind].order - KINDS[y.kind].order || cmp(x.label, y.label) || cmp(x.id, y.id);
  };
  const out = new Map<string, string[]>();
  const into = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.kind !== "traffic" || e.from === e.to || !asset(e.from) || !asset(e.to)) continue;
    const list = out.get(e.from) ?? [];
    if (!list.includes(e.to)) list.push(e.to);
    out.set(e.from, list);
    if (!out.has(e.to)) out.set(e.to, []);
    into.set(e.from, into.get(e.from) ?? 0);
    into.set(e.to, (into.get(e.to) ?? 0) + 1);
  }
  for (const list of out.values()) list.sort(order);
  const nodes = [...out.keys()].sort((a, b) => (into.get(a) === 0 ? 0 : 1) - (into.get(b) === 0 ? 0 : 1) || order(a, b));
  const state = new Map<string, 1 | 2>();
  const dag = new Map<string, string[]>();
  const post: string[] = [];
  const visit = (u: string) => {
    state.set(u, 1);
    const keep: string[] = [];
    for (const v of out.get(u)!) {
      if (state.get(v) === 1) continue; // back to a resource on the path: the cycle breaks here
      keep.push(v);
      if (!state.has(v)) visit(v);
    }
    dag.set(u, keep);
    state.set(u, 2);
    post.push(u);
  };
  for (const u of nodes) if (!state.has(u)) visit(u);
  const rank = new Map<string, number>(nodes.map((u) => [u, 0]));
  for (const u of post.reverse()) for (const v of dag.get(u)!) rank.set(v, Math.max(rank.get(v)!, rank.get(u)! + 1));
  return new Map([...rank].sort((a, b) => cmp(a[0], b[0])));
}

/** Every laid-out box's absolute bounds (the layout's positions are relative to the parent). */
export function absoluteBoxes(laid: TopologyLayoutResult): Map<string, { x: number; y: number; w: number; h: number }> {
  const out = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const n of laid.nodes) {
    const p = n.parent ? out.get(n.parent) : undefined;
    out.set(n.id, { x: n.x + (p?.x ?? 0), y: n.y + (p?.y ?? 0), w: n.w, h: n.h });
  }
  return out;
}

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
  /** A resource card (not a container). */
  card: boolean;
  /** Children positions, relative to this box. */
  kids: { box: Box; x: number; y: number }[];
}

/** The container shapes tried, as multiples of the target shape (the first wins a tie). */
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
   * The shape the containers and the top level pack for (width / height). The app always leaves it out: every view
   * gets LAYOUT_ASPECT, so the arrangement never depends on the space it is shown in. null: the fixed shelves
   * (960 / 1280) and one row at the top level (the unit tests of the shelf rules).
   */
  aspect?: number | null;
}

/**
 * Lays out `graph`, using `saved` positions where they still apply. Same graph and saved positions: same layout, in
 * every view (the tab, the full screen, the pop-out, the mini). Nothing about the space it is shown in is an input.
 */
export function layoutTopology(graph: TopologyGraph, saved: TopologyLayout | null, opts: LayoutOptions = {}): TopologyLayoutResult {
  return layoutPass(graph, saved, opts.aspect === undefined ? LAYOUT_ASPECT : opts.aspect);
}

function layoutPass(graph: TopologyGraph, saved: TopologyLayout | null, asked: number | null): TopologyLayoutResult {
  const aspect = asked !== null && Number.isFinite(asked) && asked > 0 ? asked : null;
  const ids = new Map(graph.nodes.map((n) => [n.id, n]));
  const children = new Map<string | null, TopoNode[]>();
  for (const n of graph.nodes) {
    const p = n.parent && n.parent !== n.id && ids.has(n.parent) && isGroupKind(ids.get(n.parent)!.kind) ? n.parent : null;
    const list = children.get(p);
    if (list) list.push(n);
    else children.set(p, [n]);
  }
  const savedNodes = saved?.nodes ?? {};

  // Flow order: a resource's rank; a container's, the first and the mean of the ranks inside it (none: last).
  const ranks = flowRanks(graph);
  const flowOf = new Map<string, { first: number; mean: number }>();
  const flow = (n: TopoNode): { first: number; mean: number } => {
    const known = flowOf.get(n.id);
    if (known) return known;
    let got: { first: number; mean: number };
    if (!isGroupKind(n.kind)) {
      const r = ranks.get(n.id) ?? Infinity;
      got = { first: r, mean: r };
    } else {
      const inside: number[] = [];
      const seen = new Set<string>();
      const walk = (p: string) => {
        if (seen.has(p)) return;
        seen.add(p);
        for (const k of children.get(p) ?? []) {
          if (isGroupKind(k.kind)) walk(k.id);
          else if (ranks.has(k.id)) inside.push(ranks.get(k.id)!);
        }
      };
      walk(n.id);
      got = inside.length ? { first: Math.min(...inside), mean: inside.reduce((a, b) => a + b, 0) / inside.length } : { first: Infinity, mean: Infinity };
    }
    flowOf.set(n.id, got);
    return got;
  };
  const byFlow = (a: TopoNode, b: TopoNode) => {
    const x = flow(a);
    const y = flow(b);
    if (x.first !== y.first) return x.first < y.first ? -1 : 1;
    return x.mean === y.mean ? 0 : x.mean < y.mean ? -1 : 1;
  };
  const isNet = (k: TopoNode) => k.kind === "vnet" || k.kind === "virtualHub";
  const netAddress = (a: TopoNode, b: TopoNode) => {
    const x = ipNumber(a.props.addressSpace ?? a.props.prefix);
    const y = ipNumber(b.props.addressSpace ?? b.props.prefix);
    if (x !== y) return x === null ? 1 : y === null ? -1 : x - y;
    return cmp(a.label, b.label) || cmp(a.id, b.id);
  };

  /** Sorts a container's children into packing order: by the traffic's flow first, then by the fixed rules. */
  function ordered(parent: TopoNode | null, kids: TopoNode[]): TopoNode[] {
    if (!parent) return [...kids].sort((a, b) => rootRank(a, graph.labId) - rootRank(b, graph.labId) || cmp(a.label, b.label) || cmp(a.id, b.id));
    if (parent.kind === "vnet" || parent.kind === "virtualHub") {
      // Subnets by flow, then by address; then the VNet-attached resources.
      const subnets = kids.filter((k) => k.kind === "subnet").sort((a, b) => byFlow(a, b) || byAddress("prefix")(a, b));
      const rest = kids.filter((k) => k.kind !== "subnet").sort((a, b) => byFlow(a, b) || byKind(a, b));
      return [...subnets, ...rest];
    }
    if (parent.kind === "resourceGroup" || parent.kind === "lane") {
      // By flow; then VNets and hubs by their address (a hub's is its prefix), other containers, loose resources.
      const group = (k: TopoNode) => (isNet(k) ? 0 : isGroupKind(k.kind) ? 1 : 2);
      return [...kids].sort((a, b) => byFlow(a, b) || group(a) - group(b) || (isNet(a) ? netAddress(a, b) : byKind(a, b)));
    }
    return [...kids].sort((a, b) => (isGroupKind(a.kind) === isGroupKind(b.kind) ? byFlow(a, b) || byKind(a, b) : isGroupKind(a.kind) ? -1 : 1));
  }

  /** Splits children into saved (still under the same parent key) and unsaved. */
  function split(parentKey: string | null, kids: Box[], nodes: TopoNode[]) {
    const fixed: { box: Box; x: number; y: number }[] = [];
    const free: Box[] = [];
    const freeNodes: TopoNode[] = [];
    kids.forEach((box, i) => {
      const s = Object.hasOwn(savedNodes, nodes[i]!.key) ? savedNodes[nodes[i]!.key] : undefined;
      if (s && s.p === parentKey && Number.isFinite(s.x) && Number.isFinite(s.y)) fixed.push({ box, x: s.x, y: s.y });
      else {
        free.push(box);
        freeNodes.push(nodes[i]!);
      }
    });
    return { fixed, free, freeNodes };
  }

  /** The shape every container aims for in this attempt (null: the fixed shelves). */
  let inner: number | null = null;

  function build(n: TopoNode): Box {
    if (!isGroupKind(n.kind)) return { id: n.id, w: CARD_W, h: CARD_H, card: true, kids: [] };
    const nodes = ordered(n, children.get(n.id) ?? []);
    const boxes = nodes.map(build);
    const top = headerOf(n.kind);
    const { fixed, free, freeNodes } = split(n.key, boxes, nodes);
    // Saved children are kept, pulled inside the (old) padding and below the header.
    for (const f of fixed) {
      f.x = Math.max(SAVED_PAD, Math.round(f.x));
      f.y = Math.max(top, Math.round(f.y));
    }
    const startY = fixed.length ? Math.max(...fixed.map((f) => f.y + f.box.h)) + S.gap : top + S.headGap;
    const minW = Math.max(EMPTY_W, headerWidth(n));
    const size = (all: { box: Box; x: number; y: number }[]) => ({
      w: Math.max(minW, Math.max(...all.map((k) => k.x + k.box.w)) + S.pad),
      h: Math.max(EMPTY_H, Math.max(...all.map((k) => k.y + k.box.h)) + S.pad),
    });
    let placed: { box: Box; x: number; y: number }[];
    if (n.kind === "subnet") {
      // Sources and what they feed together: flow columns (sources first), or flow rows; otherwise a grid.
      const levels = [...new Set(freeNodes.map((k) => flow(k).first))].sort((a, b) => a - b);
      if (levels.length > 1 && Number.isFinite(levels[0]!)) {
        const runs = levels.map((l) => free.filter((_, i) => flow(freeNodes[i]!).first === l));
        placed = layered(runs, S.pad, startY, false);
        if (inner) placed = closest([placed, layered(runs, S.pad, startY, true)], (t) => size([...fixed, ...t]), inner);
      } else {
        const cols = Math.min(3, Math.ceil(Math.sqrt(Math.max(1, boxes.length))));
        placed = grid(free, cols, S.pad, startY);
        if (inner && free.length > 1) {
          // Any number of columns up to 4: the one whose box comes closest to the target shape.
          const tries = Array.from({ length: Math.min(4, free.length) }, (_, i) => grid(free, i + 1, S.pad, startY));
          placed = closest(tries, (t) => size([...fixed, ...t]), inner);
        }
      }
    } else {
      const widest = Math.max(0, ...boxes.map((b) => b.w));
      const shelf = Math.max(widest, n.kind === "vnet" || n.kind === "virtualHub" ? VNET_SHELF : RG_SHELF);
      placed = shelfPack(free, shelf, S.pad, startY);
      if (inner && free.length > 1) placed = closest(rowWidths(free).map((wd) => shelfPack(free, Math.max(wd, widest), S.pad, startY)), (t) => size([...fixed, ...t]), inner);
    }
    const all = [...fixed, ...placed];
    if (all.length === 0) return { id: n.id, w: minW, h: EMPTY_H, card: false, kids: [] };
    const { w, h } = size(all);
    // Kids in packing order, so the output order is stable.
    const order = new Map(boxes.map((b, i) => [b, i]));
    all.sort((a, b) => order.get(a.box)! - order.get(b.box)!);
    return { id: n.id, w, h, card: false, kids: all };
  }

  const roots = ordered(null, children.get(null) ?? []);
  const bounds = (all: { box: Box; x: number; y: number }[]) =>
    all.length
      ? { w: Math.max(...all.map((k) => k.x + k.box.w)) - Math.min(0, ...all.map((k) => k.x)), h: Math.max(...all.map((k) => k.y + k.box.h)) - Math.min(0, ...all.map((k) => k.y)) }
      : { w: 0, h: 0 };

  /** The whole picture with every container aiming for `shape`; the top level aims for the target shape. */
  function attempt(shape: number | null) {
    inner = shape;
    const rootBoxes = roots.map(build);
    const { fixed, free } = split(null, rootBoxes, roots);
    for (const f of fixed) {
      f.x = Math.round(f.x);
      f.y = Math.round(f.y);
    }
    const rootTop = fixed.length ? Math.max(...fixed.map((f) => f.y + f.box.h)) + S.rootGap : 0;
    let x = 0;
    let placed = free.map((box) => {
      const at = { box, x, y: rootTop };
      x += box.w + S.rootGap;
      return at;
    });
    if (aspect && free.length > 1) {
      // Wrap the top level into rows (gateway, Global, groups, Tenant, in order) to come closest to the target shape.
      const widest = Math.max(...free.map((b) => b.w));
      placed = closest(rowWidths(free, S.rootGap).map((wd) => shelfPack(free, Math.max(wd, widest), 0, rootTop, S.rootGap)), (t) => bounds([...fixed, ...t]), aspect);
    }
    const order = new Map(rootBoxes.map((b, i) => [b, i]));
    return [...fixed, ...placed].sort((a, b) => order.get(a.box)! - order.get(b.box)!);
  }

  // With a target shape, containers try a few shapes of their own around it (a tall group can sit beside a wide one);
  // the fixed shelves are tried last. The picture that fits that shape at the largest zoom wins, the shape itself
  // first on a tie.
  const top = aspect ? closest([...INNER_SHAPES.map((f) => attempt(aspect * f)), attempt(null)], bounds, aspect) : attempt(null);

  const out: LaidNode[] = [];
  const walk = (k: { box: Box; x: number; y: number }, parent: string | null) => {
    out.push({ id: k.box.id, x: k.x, y: k.y, w: k.box.w, h: k.box.h, parent });
    for (const c of k.box.kids) walk(c, k.box.id);
  };
  for (const k of top) walk(k, null);
  return { nodes: out };
}

/** Fixed-size cells in `cols` columns, row by row, the card gaps apart. */
function grid(boxes: Box[], cols: number, x0: number, y0: number) {
  return boxes.map((box, i) => ({ box, x: x0 + (i % cols) * (CARD_W + S.cardX), y: y0 + Math.floor(i / cols) * (CARD_H + S.cardY) }));
}

/**
 * Flow columns: each run of cards (one flow rank, sources first) in a column of its own, left to right, each column
 * centred on the tallest, so a source sits level with the middle of what it feeds. `rows`: the same turned, top to
 * bottom. A run longer than FLOW_RUN wraps into more columns (rows) side by side.
 */
function layered(runs: Box[][], x0: number, y0: number, rows: boolean) {
  const cols = runs.flatMap((r) => Array.from({ length: Math.ceil(r.length / FLOW_RUN) }, (_, i) => r.slice(i * FLOW_RUN, (i + 1) * FLOW_RUN)));
  const most = Math.max(...cols.map((c) => c.length));
  const stepX = CARD_W + S.cardX;
  const stepY = CARD_H + S.cardY;
  const out: { box: Box; x: number; y: number }[] = [];
  cols.forEach((col, i) => {
    const shift = most - col.length;
    col.forEach((box, j) => {
      if (rows) out.push({ box, x: x0 + (shift * stepX) / 2 + j * stepX, y: y0 + i * stepY });
      else out.push({ box, x: x0 + i * stepX, y: y0 + (shift * stepY) / 2 + j * stepY });
    });
  });
  return out;
}

/** The gap between two neighbours on a shelf: the card gap between two cards, the corridor otherwise (or a fixed one). */
const gapOf = (a: Box, b: Box, fixed?: number) => fixed ?? (a.card && b.card ? S.cardX : S.gap);

/** Left to right in rows no wider than `width`, each row as tall as its tallest box. */
function shelfPack(boxes: Box[], width: number, x0: number, y0: number, fixedGap?: number) {
  const out: { box: Box; x: number; y: number }[] = [];
  const rowGap = Math.max(fixedGap ?? S.gap, S.cardY);
  let x = 0;
  let y = y0;
  let rowH = 0;
  let prev: Box | null = null;
  for (const box of boxes) {
    const gap = prev ? gapOf(prev, box, fixedGap) : 0;
    if (x > 0 && x + gap + box.w > width) {
      y += rowH + rowGap;
      x = 0;
      rowH = 0;
    } else x += gap;
    out.push({ box, x: x0 + x, y });
    x += box.w;
    rowH = Math.max(rowH, box.h);
    prev = box;
  }
  return out;
}

/** The row widths worth trying: the first k boxes side by side, for every k (ascending, so ties keep the narrower). */
function rowWidths(boxes: Box[], fixedGap?: number): number[] {
  const out: number[] = [];
  let w = 0;
  boxes.forEach((b, i) => {
    w += (i ? gapOf(boxes[i - 1]!, b, fixedGap) : 0) + b.w;
    out.push(w);
  });
  return out;
}

/**
 * The packing whose bounds fit a screen of shape `aspect` at the largest zoom:
 * the smallest max(w / aspect, h); among near ties, the one whose shape is
 * closest to `aspect`. The first wins a tie, so the result is deterministic.
 */
function closest<T>(tries: T[], bounds: (t: T) => { w: number; h: number }, aspect: number): T {
  let best = tries[0] as T;
  let score = Infinity;
  let off = Infinity;
  for (const t of tries) {
    const b = bounds(t);
    const s = Math.max(b.w / aspect, b.h);
    const o = Math.abs(Math.log(b.w / Math.max(1, b.h) / aspect));
    if (s < score - 0.5 || (s <= score + 0.5 && o < off - 0.01)) {
      best = t;
      score = Math.min(score, s);
      off = o;
    }
  }
  return best;
}
