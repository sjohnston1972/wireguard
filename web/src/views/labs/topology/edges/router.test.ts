// The diagram's edge router (router.ts): every line gets its own lane. For real planned labs, laid out as the full
// screen and the lab dialog's Diagram tab show them: no two lines share a stretch, no line passes through a card it
// does not start or end at, and every label sits on its own line, clear of the cards, the headers and the other labels.
import { describe, expect, it } from "vitest";
import type { TopologyGraph } from "@shared/topology/model";
import { isGroupKind } from "@shared/topology/model";
import { absoluteBoxes, HEADER, layoutTopology, SUBNET_HEADER } from "../layout";
import { stackGraph } from "../stacks";
import { nodeIndex } from "../words";
import { buildEdges } from "./buildEdges";
import { labelSize, type Box, type Pt } from "./labelSpot";
import { edgeLabelText, routeAll, type RouterBox, type RoutedEdge } from "./router";

const PLANNED = import.meta.glob<TopologyGraph>("../../../../../../shared/topology/planned/*.json", { eager: true, import: "default" });
const planned = (id: string) => stackGraph(Object.entries(PLANNED).find(([k]) => k.endsWith(`/${id}.json`))![1]).graph;

/** The canvas spaces: full screen at 2000 × 1030 and the lab dialog's Diagram tab at 1600 × 900 (less the panel row). */
const FULL = { w: 1934, h: 746 };
const TAB = { w: 905, h: 500 };
const LABS = ["az104-16-lb-appgw", "az700-40-lb-advanced", "az700-36-s2s-vpn", "az700-39-vwan-secured-hub", "az305-28-three-tier", "az104-14-peering-udr"];

function routed(id: string, space: { w: number; h: number }) {
  const graph = planned(id);
  const byId = nodeIndex(graph);
  const laid = layoutTopology(graph, null, { space, maxZoom: 1.75 });
  const abs = absoluteBoxes(laid);
  const boxes: RouterBox[] = laid.nodes.map((l) => {
    const n = byId.get(l.id)!;
    const a = abs.get(l.id)!;
    const group = isGroupKind(n.kind);
    return { id: l.id, x: a.x, y: a.y, w: a.w, h: a.h, group, head: group ? (n.kind === "subnet" ? SUBNET_HEADER : HEADER) : 0 };
  });
  const edges = buildEdges(graph, byId, { showDependencies: true, labels: true, animate: false, reducedMotion: false }).map((e) => ({ id: e.id, from: e.source, to: e.target, label: edgeLabelText(e.data!) }));
  return { graph, boxes, edges, routes: routeAll({ boxes, edges }) };
}

type Seg = { a: Pt; b: Pt };
const segs = (r: RoutedEdge): Seg[] => r.points.slice(1).map((b, i) => ({ a: r.points[i]!, b }));
const horiz = (s: Seg) => Math.abs(s.a.y - s.b.y) < 0.01;
const vert = (s: Seg) => Math.abs(s.a.x - s.b.x) < 0.01;

/** How long two segments run along the same line, or so close beside each other (under 6px) they read as one. */
function sharedLength(p: Seg, q: Seg): number {
  if (horiz(p) && horiz(q) && Math.abs(p.a.y - q.a.y) < 6) {
    return Math.min(Math.max(p.a.x, p.b.x), Math.max(q.a.x, q.b.x)) - Math.max(Math.min(p.a.x, p.b.x), Math.min(q.a.x, q.b.x));
  }
  if (vert(p) && vert(q) && Math.abs(p.a.x - q.a.x) < 6) {
    return Math.min(Math.max(p.a.y, p.b.y), Math.max(q.a.y, q.b.y)) - Math.max(Math.min(p.a.y, p.b.y), Math.min(q.a.y, q.b.y));
  }
  return 0;
}

/** Whether a segment passes through the inside of a box (running along its border does not count). */
function through(s: Seg, b: Box): boolean {
  const x0 = Math.min(s.a.x, s.b.x);
  const x1 = Math.max(s.a.x, s.b.x);
  const y0 = Math.min(s.a.y, s.b.y);
  const y1 = Math.max(s.a.y, s.b.y);
  return x1 > b.x + 1 && x0 < b.x + b.w - 1 && y1 > b.y + 1 && y0 < b.y + b.h - 1;
}

const overlap = (p: Box, q: Box) => p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;

describe("routeAll on real labs", () => {
  for (const id of LABS)
    for (const [name, space] of [
      ["full screen", FULL],
      ["tab", TAB],
    ] as const) {
      it(`${id} (${name}): every edge is routed, orthogonal, and no two edges share a stretch of line`, () => {
        const { edges, routes } = routed(id, space);
        for (const e of edges) {
          const r = routes.get(e.id);
          expect(r, e.id).toBeDefined();
          expect(r!.points.length, e.id).toBeGreaterThanOrEqual(2);
          for (const s of segs(r!)) expect(horiz(s) || vert(s), `${e.id} is orthogonal`).toBe(true);
        }
        for (let i = 0; i < edges.length; i++)
          for (let j = i + 1; j < edges.length; j++)
            for (const p of segs(routes.get(edges[i]!.id)!))
              for (const q of segs(routes.get(edges[j]!.id)!)) expect(sharedLength(p, q), `${edges[i]!.id} and ${edges[j]!.id} share a stretch`).toBeLessThanOrEqual(1);
      });

      it(`${id} (${name}): no edge passes through a card (its own cards included: it starts and ends on their borders)`, () => {
        const { boxes, edges, routes } = routed(id, space);
        const cards = boxes.filter((b) => !b.group);
        for (const e of edges) for (const s of segs(routes.get(e.id)!)) for (const c of cards) expect(through(s, c), `${e.id} through ${c.id}`).toBe(false);
      });

      it(`${id} (${name}): each label sits on its own line, clear of every card, header and other label`, () => {
        const { boxes, edges, routes } = routed(id, space);
        const cards = boxes.filter((b) => !b.group);
        const heads = boxes.filter((b) => b.group).map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.head }));
        const labels: { id: string; box: Box }[] = [];
        for (const e of edges) {
          const r = routes.get(e.id)!;
          if (!e.label) {
            expect(r.label).toBeNull();
            continue;
          }
          expect(r.label, e.id).not.toBeNull();
          const size = labelSize(e.label);
          const box = { x: r.label!.x - size.w / 2, y: r.label!.y - size.h / 2, w: size.w, h: size.h };
          // On one of its own segments.
          const on = segs(r).some((s) => (horiz(s) ? Math.abs(r.label!.y - s.a.y) < 0.5 && r.label!.x >= Math.min(s.a.x, s.b.x) - 0.5 && r.label!.x <= Math.max(s.a.x, s.b.x) + 0.5 : Math.abs(r.label!.x - s.a.x) < 0.5 && r.label!.y >= Math.min(s.a.y, s.b.y) - 0.5 && r.label!.y <= Math.max(s.a.y, s.b.y) + 0.5));
          expect(on, `${e.id}'s label is on its line`).toBe(true);
          for (const c of [...cards, ...heads]) expect(overlap(box, c), `${e.id}'s label on ${"id" in c ? c.id : "a header"}`).toBe(false);
          for (const l of labels) expect(overlap(box, l.box), `${e.id}'s label on ${l.id}'s`).toBe(false);
          labels.push({ id: e.id, box });
        }
      });
    }

  it("lab 16: each card side gives every edge its own port (the two lines from lbi-web leave at different points)", () => {
    const { graph, routes } = routed("az104-16-lb-appgw", FULL);
    const from = (label: string) => graph.edges.filter((e) => graph.nodes.find((n) => n.id === e.from)!.label === label).map((e) => routes.get(e.id)!.points[0]!);
    for (const who of ["lbi-web", "agw-web"]) {
      const starts = from(who);
      expect(starts).toHaveLength(2);
      expect(starts[0]!.x !== starts[1]!.x || starts[0]!.y !== starts[1]!.y, who).toBe(true);
    }
  });

  it("is deterministic: the same boxes and edges, in any order, route the same", () => {
    const { boxes, edges, routes } = routed("az700-40-lb-advanced", FULL);
    const again = routeAll({ boxes: [...boxes].reverse(), edges: [...edges].reverse() });
    for (const e of edges) expect(again.get(e.id)).toEqual(routes.get(e.id));
  });

  it("edges between containers (peerings) are routed too, from the containers' borders", () => {
    const { graph, boxes, routes } = routed("az104-14-peering-udr", FULL);
    const peering = graph.edges.find((e) => /peering/i.test(e.label ?? ""))!;
    const r = routes.get(peering.id)!;
    const src = boxes.find((b) => b.id === peering.from)!;
    const p = r.points[0]!;
    const onBorder = Math.abs(p.x - src.x) < 0.5 || Math.abs(p.x - (src.x + src.w)) < 0.5 || Math.abs(p.y - src.y) < 0.5 || Math.abs(p.y - (src.y + src.h)) < 0.5;
    expect(onBorder).toBe(true);
    expect(isGroupKind(graph.nodes.find((n) => n.id === peering.from)!.kind)).toBe(true);
  });
});
