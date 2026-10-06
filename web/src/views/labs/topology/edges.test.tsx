// Lab topology plan T1.4: edges (spec §9.2).
import { beforeAll, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { getSmoothStepPath, Position, ReactFlow, ReactFlowProvider, type Node } from "@xyflow/react";
import type { TopologyGraph, TopoNode } from "@shared/topology/model";
import { floatingEnds } from "./edges/floating";
import { buildEdges } from "./edges/buildEdges";
import { EDGE_TYPES } from "./edges/TopoEdges";
import { installFlowStandIns } from "./flowTestEnv";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const topologyCss = readFileSync([join(process.cwd(), "web/src/views/labs/topology/topology.css"), join(process.cwd(), "src/views/labs/topology/topology.css")].find((p) => existsSync(p))!, "utf8");

beforeAll(installFlowStandIns);

const box = (x: number, y: number, w = 200, h = 84) => ({ x, y, w, h });

describe("floatingEnds", () => {
  it("each edge meets the nearest sides of its nodes: side by side", () => {
    expect(floatingEnds(box(0, 0), box(400, 20))).toEqual({ sx: 200, sy: 42, tx: 400, ty: 62, sourceSide: "right", targetSide: "left" });
    expect(floatingEnds(box(400, 20), box(0, 0))).toMatchObject({ sourceSide: "left", targetSide: "right", sx: 400, tx: 200 });
  });

  it("each edge meets the nearest sides of its nodes: one above the other", () => {
    expect(floatingEnds(box(0, 0), box(30, 300))).toEqual({ sx: 100, sy: 84, tx: 130, ty: 300, sourceSide: "bottom", targetSide: "top" });
    expect(floatingEnds(box(30, 300), box(0, 0))).toMatchObject({ sourceSide: "top", targetSide: "bottom" });
  });

  it("diagonal boxes use the axis with the wider gap", () => {
    // 100 apart across, 400 apart down: top/bottom.
    expect(floatingEnds(box(0, 0), box(300, 484))).toMatchObject({ sourceSide: "bottom", targetSide: "top" });
    // 600 apart across, 20 down: left/right.
    expect(floatingEnds(box(0, 0), box(800, 104))).toMatchObject({ sourceSide: "right", targetSide: "left" });
  });
});

const n = (id: string, label = id): TopoNode => ({ id, key: id, kind: "vm", label, props: {} });
const graph: TopologyGraph = {
  schema: 1,
  labId: "az700-40-lb-advanced",
  version: 1,
  source: "planned",
  at: null,
  nodes: [n("lb", "lb-svc"), n("vm", "vm-svc"), n("id", "id-app")],
  edges: [
    { id: "e1", from: "lb", to: "vm", kind: "traffic", label: "TCP 80→80" },
    { id: "e2", from: "id", to: "vm", kind: "dependency", label: "role: Reader" },
    { id: "e3", from: "lb", to: "gone", kind: "traffic" },
  ],
};
const byId = new Map(graph.nodes.map((x) => [x.id, x]));
const base = { showDependencies: true, labels: true, animate: false, reducedMotion: false };

describe("buildEdges", () => {
  it("traffic edges are smoothstep-drawn traffic edges, focusable, with a name", () => {
    const [t] = buildEdges(graph, byId, base);
    expect(t).toMatchObject({ id: "e1", type: "traffic", focusable: true, ariaLabel: "lb-svc to vm-svc: TCP 80→80", data: { label: "TCP 80→80", showLabel: true } });
  });

  it("dependency edges are dashed, not focusable and hidden when showDependencies is false", () => {
    const dep = buildEdges(graph, byId, base)[1]!;
    expect(dep).toMatchObject({ type: "dependency", focusable: false, selectable: false, hidden: false });
    expect(buildEdges(graph, byId, { ...base, showDependencies: false })[1]!.hidden).toBe(true);
  });

  it("drops an edge to a node outside the graph", () => {
    expect(buildEdges(graph, byId, base).map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  it("no edge animates by default or under reduced motion", () => {
    expect(buildEdges(graph, byId, base).some((e) => e.animated)).toBe(false);
    expect(buildEdges(graph, byId, { ...base, animate: true, reducedMotion: true }).some((e) => e.animated)).toBe(false);
    expect(buildEdges(graph, byId, { ...base, animate: true })[0]!.animated).toBe(true);
    // Dependency edges never animate.
    expect(buildEdges(graph, byId, { ...base, animate: true })[1]!.animated).toBe(false);
  });

  it("the mini variant has no labels", () => {
    expect(buildEdges(graph, byId, { ...base, labels: false })[0]!.data!.showLabel).toBe(false);
  });

  it("traffic edges between the same two nodes (either way) share one label chip, a line each, so labels never sit on each other", () => {
    const g2: TopologyGraph = {
      ...graph,
      edges: [
        { id: "a", from: "lb", to: "vm", kind: "traffic", label: "TCP 80→80" },
        { id: "b", from: "lb", to: "vm", kind: "traffic", label: "TCP 8081-8090→8080" },
        { id: "c", from: "vm", to: "lb", kind: "traffic", label: "outbound" },
        { id: "d", from: "id", to: "vm", kind: "dependency", label: "role: Reader" },
      ],
    };
    const out = buildEdges(g2, byId, base);
    expect(out.map((e) => [e.id, e.data!.showLabel])).toEqual([["a", true], ["b", false], ["c", false], ["d", true]]);
    expect(out[0]!.data!.label).toBe("TCP 80→80\nTCP 8081-8090→8080\noutbound");
    // Each edge keeps its own name for screen readers.
    expect(out[2]!.ariaLabel).toBe("vm-svc to lb-svc: outbound");
  });
});

describe("edges on the canvas", () => {
  const handles = (w: number, h: number) =>
    (["top", "right", "bottom", "left"] as const).map((p) => ({
      id: p,
      type: "source" as const,
      position: p as Position,
      x: p === "right" ? w : p === "left" ? 0 : w / 2,
      y: p === "bottom" ? h : p === "top" ? 0 : h / 2,
      width: 1,
      height: 1,
    }));
  const flowNodes: Node[] = [
    { id: "lb", position: { x: 0, y: 0 }, width: 200, height: 84, handles: handles(200, 84), data: {} },
    { id: "vm", position: { x: 400, y: 20 }, width: 200, height: 84, handles: handles(200, 84), data: {} },
    { id: "id", position: { x: 0, y: 300 }, width: 200, height: 84, handles: handles(200, 84), data: {} },
  ];

  function draw() {
    return render(
      <div style={{ width: 800, height: 600 }}>
        <ReactFlowProvider>
          <ReactFlow nodes={flowNodes} edges={buildEdges(graph, byId, base)} edgeTypes={EDGE_TYPES} connectionMode={"loose" as never} />
        </ReactFlowProvider>
      </div>,
    );
  }

  it("traffic edges are smoothstep with their label", () => {
    const { container } = draw();
    const path = container.querySelector('[data-id="e1"] path.react-flow__edge-path');
    const e = floatingEnds(box(0, 0), box(400, 20));
    const [expected] = getSmoothStepPath({ sourceX: e.sx, sourceY: e.sy, sourcePosition: Position.Right, targetX: e.tx, targetY: e.ty, targetPosition: Position.Left, borderRadius: 10, offset: 18 });
    expect(path).toHaveAttribute("d", expected);
    expect(path).toHaveClass("topo-edge--traffic");
    expect(screen.getByText("TCP 80→80")).toHaveClass("topo-edge-label");
    expect(container.querySelector('[data-id="e1"]')).toHaveAttribute("tabindex", "0");
  });

  it("edge labels are drawn above the nodes: React Flow puts its label layer under the nodes, so the canvas lifts it", () => {
    const { container } = draw();
    const label = screen.getByText("TCP 80→80");
    // Rendered into React Flow's label layer, with a chip background so it reads over lines.
    expect(label.closest(".react-flow__edgelabel-renderer")).not.toBeNull();
    const rule = (sel: string) => new RegExp(`(?:^|\n)${sel.replace(/[.[\]]/g, "\\$&")}\\s*\\{[^}]*`).exec(topologyCss)?.[0] ?? "";
    const layer = rule(".topo-canvas .react-flow__edgelabel-renderer");
    expect(Number(/z-index:\s*(\d+)/.exec(layer)?.[1] ?? 0)).toBeGreaterThanOrEqual(1000);
    expect(rule(".topo-edge-label")).toMatch(/background:\s*var\(--bg-elevated\)/);
    expect(container.querySelector(".react-flow__edgelabel-renderer")).not.toBeNull();
  });

  it("edges run under the containers (whose bodies are see-through) and so under their headers and the cards", () => {
    for (const e of buildEdges(graph, byId, base)) expect(e.zIndex, e.id).toBeLessThan(0);
    const rule = (sel: string) => new RegExp(`(?:^|\n)${sel.replace(/[.[\]]/g, "\\$&")}\\s*\\{[^}]*`).exec(topologyCss)?.[0] ?? "";
    // Each container's header strip is opaque, so a line passing under it never crosses its name or chips.
    expect(rule(".topo-group__head")).toMatch(/background:\s*var\(--topo-head-bg\)/);
    for (const k of ["--topo-vnet-fill", "--topo-subnet-fill", "--topo-rg-fill"]) expect(new RegExp(`${k}:[^;]*transparent`).test(topologyCss), k).toBe(true);
  });

  it("dependency edges are dashed and never focusable", () => {
    const { container } = draw();
    const dep = container.querySelector('[data-id="e2"]');
    expect(dep).not.toHaveAttribute("tabindex");
    expect(dep!.querySelector("path.react-flow__edge-path")).toHaveClass("topo-edge--dependency");
  });
});
