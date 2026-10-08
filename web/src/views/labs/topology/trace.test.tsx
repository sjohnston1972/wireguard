// Trace highlighting: hovering, focusing or selecting a node lights up its lines and the nodes at their other ends
// and dims the rest; hovering or focusing a line lights it and its two ends. Pure sets (trace.ts), then on the canvas.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TopologyGraph } from "@shared/topology/model";
import { Canvas } from "./Canvas";
import type { CanvasProps } from "./contract";
import { traceSets } from "./trace";
import { resetSpriteForTests } from "./icons/sprite";
import { installFlowStandIns } from "./flowTestEnv";

beforeAll(installFlowStandIns);
beforeEach(() => {
  resetSpriteForTests();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 404 })));
});
afterEach(() => vi.unstubAllGlobals());

const topologyCss = readFileSync([join(process.cwd(), "web/src/views/labs/topology/topology.css"), join(process.cwd(), "src/views/labs/topology/topology.css")].find((p) => existsSync(p))!, "utf8");

const PLANNED = import.meta.glob<TopologyGraph>("../../../../../shared/topology/planned/*.json", { eager: true, import: "default" });
const lab16 = Object.entries(PLANNED).find(([k]) => k.endsWith("/az104-16-lb-appgw.json"))![1];
const idOf = (label: string) => lab16.nodes.find((n) => n.label === label)!.id;
const edgesOf = (label: string) => lab16.edges.filter((e) => e.from === idOf(label) || e.to === idOf(label)).map((e) => e.id);

describe("traceSets", () => {
  const edges = lab16.edges.map((e) => ({ id: e.id, source: e.from, target: e.to }));

  it("nothing traced: null", () => {
    expect(traceSets(edges, null)).toBeNull();
  });

  it("a node: its own lines and the nodes at their other ends, nothing else", () => {
    const t = traceSets(edges, { kind: "node", id: idOf("lbi-web") })!;
    expect([...t.edges].sort()).toEqual(edgesOf("lbi-web").sort());
    expect([...t.nodes].sort()).toEqual([idOf("lbi-web"), idOf("vm-web1"), idOf("vm-web2")].sort());
    expect(t.nodes.has(idOf("agw-web"))).toBe(false);
  });

  it("a line: the line and its two ends", () => {
    const e = lab16.edges.find((x) => x.from === idOf("agw-web") && x.to === idOf("vm-web2"))!;
    const t = traceSets(edges, { kind: "edge", id: e.id })!;
    expect([...t.edges]).toEqual([e.id]);
    expect([...t.nodes].sort()).toEqual([idOf("agw-web"), idOf("vm-web2")].sort());
  });

  it("a node with no lines, or a hidden line, traces nothing (no dimming for nothing)", () => {
    expect(traceSets(edges, { kind: "node", id: "tf:azurerm_subnet.web" })).toBeNull();
    expect(traceSets([{ id: "x", source: "a", target: "b", hidden: true }], { kind: "edge", id: "x" })).toBeNull();
    expect(traceSets([{ id: "x", source: "a", target: "b", hidden: true }], { kind: "node", id: "a" })).toBeNull();
  });
});

describe("trace highlighting on the canvas", () => {
  function props(over: Partial<CanvasProps> = {}): CanvasProps {
    return { graph: lab16, status: {}, saved: null, view: "diagram", showDependencies: true, search: "", variant: "tab", selected: null, onSelect: () => {}, onMove: () => {}, ...over };
  }
  const draw = (p: CanvasProps) =>
    render(
      <div style={{ width: 800, height: 600 }}>
        <Canvas {...p} />
      </div>,
    );
  const node = (c: HTMLElement, label: string) => c.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(idOf(label))}"]`)!;
  const edgePath = (c: HTMLElement, id: string) => c.querySelector(`.react-flow__edge[data-id="${CSS.escape(id)}"] path.react-flow__edge-path`)!;
  const edgeG = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`.react-flow__edge[data-id="${CSS.escape(id)}"]`)!;
  const others = (label: string) => lab16.edges.map((e) => e.id).filter((id) => !edgesOf(label).includes(id));

  function expectTraced(c: HTMLElement, on: string[], off: string[], edgesOn: string[], edgesOff: string[]) {
    for (const l of on) expect(node(c, l), `${l} on`).toHaveClass("topo-trace-on");
    for (const l of off) expect(node(c, l), `${l} off`).toHaveClass("topo-trace-off");
    for (const id of edgesOn) expect(edgePath(c, id), `${id} on`).toHaveClass("topo-edge--trace");
    for (const id of edgesOff) expect(edgePath(c, id), `${id} off`).toHaveClass("topo-edge--faded");
  }

  it("hovering a node lights its lines and neighbours and dims the rest; leaving clears it", () => {
    const { container } = draw(props());
    expect(container.querySelector(".topo-trace-on, .topo-trace-off, .topo-edge--faded")).toBeNull();
    act(() => void fireEvent.mouseEnter(node(container, "lbi-web")));
    expectTraced(container, ["lbi-web", "vm-web1", "vm-web2"], ["agw-web"], edgesOf("lbi-web"), others("lbi-web"));
    act(() => void fireEvent.mouseLeave(node(container, "lbi-web")));
    expect(container.querySelector(".topo-trace-on, .topo-trace-off, .topo-edge--faded")).toBeNull();
  });

  it("hovering a line lights it and its two ends", () => {
    const { container } = draw(props());
    const e = lab16.edges.find((x) => x.from === idOf("agw-web") && x.to === idOf("vm-web2"))!;
    act(() => void fireEvent.mouseEnter(edgeG(container, e.id)));
    expectTraced(
      container,
      ["agw-web", "vm-web2"],
      ["lbi-web", "vm-web1"],
      [e.id],
      lab16.edges.map((x) => x.id).filter((id) => id !== e.id),
    );
  });

  it("keyboard focus on a node traces it too", () => {
    const { container } = draw(props());
    act(() => node(container, "agw-web").focus());
    expectTraced(container, ["agw-web", "vm-web1", "vm-web2"], ["lbi-web"], edgesOf("agw-web"), others("agw-web"));
    act(() => node(container, "agw-web").blur());
    expect(container.querySelector(".topo-trace-on, .topo-trace-off")).toBeNull();
  });

  it("the selected node stays traced while nothing is hovered", () => {
    const { container } = draw(props({ selected: idOf("vm-web1") }));
    expectTraced(container, ["vm-web1", "lbi-web", "agw-web"], ["vm-web2"], edgesOf("vm-web1"), others("vm-web1"));
  });

  it("the mini variant never traces", () => {
    const { container } = draw(props({ variant: "mini", selected: idOf("vm-web1") }));
    expect(container.querySelector(".topo-trace-on, .topo-trace-off, .topo-edge--faded")).toBeNull();
  });

  it("the fade is animated only when motion is welcome", () => {
    // Every transition on the trace classes sits inside a no-preference block.
    const outside = topologyCss.replace(/@media \(prefers-reduced-motion: no-preference\)\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    expect(outside).not.toMatch(/transition/);
    expect(topologyCss).toMatch(/@media \(prefers-reduced-motion: no-preference\)\s*\{[^@]*topo-trace[^@]*transition/);
  });
});
