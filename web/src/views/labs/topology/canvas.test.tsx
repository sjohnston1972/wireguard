// Lab topology plan T1.5: the real Canvas (React Flow behind CanvasProps).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TopologyGraph } from "@shared/topology/model";
import { Canvas } from "./Canvas";
import { PHONE_MIN_FIT_ZOOM, quantiseLength } from "./FlowCanvas";
import { PANEL_RESERVE, START_INSET } from "./viewport";
import type { CanvasProps } from "./contract";
import { toFlowNodes, movesOf } from "./flowNodes";
import { layoutTopology } from "./layout";
import { requestFit } from "./fitBus";
import { resetSpriteForTests, SPRITE_URL } from "./icons/sprite";
import { installFlowStandIns, measureFromStyle } from "./flowTestEnv";
import flowSource from "./FlowCanvas.tsx?raw";

beforeAll(installFlowStandIns);

const LAB = "az104-06-blob-security";
const RG = `microsoft.resources/resourcegroups/rg-lab-${LAB}`;
const graph: TopologyGraph = {
  schema: 1,
  labId: LAB,
  version: 1,
  source: "planned",
  at: null,
  nodes: [
    { id: "rg", key: RG, kind: "resourceGroup", label: `rg-lab-${LAB}`, props: { region: "uksouth" } },
    { id: "vnet", key: "vnet-key", kind: "vnet", label: "vnet-lab", parent: "rg", props: { addressSpace: ["10.71.192.0/20"] } },
    { id: "snet", key: "snet-key", kind: "subnet", label: "snet-app", parent: "vnet", props: { prefix: "10.71.192.0/24" } },
    { id: "vm", key: "vm-key", kind: "vm", label: "vm-app", parent: "snet", props: { size: "Standard_B1s", privateIp: "10.71.192.4" }, health: { tone: "ok", word: "Running" } },
    { id: "lb", key: "lb-key", kind: "loadBalancer", label: "lb-app", parent: "rg", props: {} },
  ],
  edges: [{ id: "e1", from: "lb", to: "vm", kind: "traffic", label: "TCP 80→80" }],
};

const SPRITE = '<svg xmlns="http://www.w3.org/2000/svg" style="display:none"><symbol id="az-virtual-machine" viewBox="0 0 18 18"><path d="M0 0h18v18H0z"/></symbol></svg>';
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetSpriteForTests();
  fetchMock = vi.fn(async (url: string) => (url === SPRITE_URL ? new Response(SPRITE, { status: 200 }) : new Response("no", { status: 404 })));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

function props(over: Partial<CanvasProps> = {}): CanvasProps {
  return { graph, status: {}, saved: null, view: "diagram", showDependencies: true, search: "", variant: "tab", selected: null, onSelect: () => {}, onMove: () => {}, ...over };
}
const draw = (p: CanvasProps) =>
  render(
    <div style={{ width: 800, height: 600 }}>
      <Canvas {...p} />
    </div>,
  );
const nodeEl = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
const viewport = (c: HTMLElement) => c.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform;

describe("toFlowNodes", () => {
  it("nests children with parentId, extent parent and expandParent, parents first", () => {
    const laid = layoutTopology(graph, null);
    const nodes = toFlowNodes(laid, new Map(graph.nodes.map((n) => [n.id, n])), { status: {}, variant: "tab", selected: null, search: "" });
    const vm = nodes.find((n) => n.id === "vm")!;
    expect(vm).toMatchObject({ parentId: "snet", extent: "parent", expandParent: true, width: 200, height: 84, type: "topoAsset" });
    expect(nodes.find((n) => n.id === "rg")).toMatchObject({ type: "topoGroup" });
    expect(nodes.find((n) => n.id === "rg")!.parentId).toBeUndefined();
    const order = nodes.map((n) => n.id);
    expect(order.indexOf("snet")).toBeLessThan(order.indexOf("vm"));
  });
});

describe("movesOf", () => {
  it("a drag end (a position change with dragging false) is a move with the relative position and parent key", () => {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(movesOf([{ type: "position", id: "vm", position: { x: 40.4, y: 99.6 }, dragging: false }], byId, new Set(["vm"]))).toEqual([{ key: "vm-key", at: { x: 40, y: 100, p: "snet-key" } }]);
    // Mid-drag positions and nodes not being moved (a parent growing) are not saved.
    expect(movesOf([{ type: "position", id: "vm", position: { x: 1, y: 1 }, dragging: true }], byId, new Set(["vm"]))).toEqual([]);
    expect(movesOf([{ type: "position", id: "snet", position: { x: 0, y: 0 }, dragging: false }], byId, new Set(["vm"]))).toEqual([]);
    // A root node saves p null.
    expect(movesOf([{ type: "position", id: "rg", position: { x: 5, y: 6 }, dragging: false }], byId, new Set(["rg"]))).toEqual([{ key: RG, at: { x: 5, y: 6, p: null } }]);
  });
});

describe("Canvas", () => {
  it("draws every node with its accessible name and the traffic edge", () => {
    const { container } = draw(props());
    expect(screen.getByRole("group", { name: "VM vm-app in snet-app, Running, private IP 10.71.192.4" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /^Subnet snet-app in vnet-lab/ })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "lb-app to vm-app: TCP 80→80" })).toBeInTheDocument();
    // Positions nest: the VM sits inside its subnet.
    const vm = nodeEl(container, "vm").style.transform;
    const snet = nodeEl(container, "snet").style.transform;
    const xy = (t: string) => t.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/)!.slice(1).map(Number);
    expect(xy(vm)[0]).toBeGreaterThan(xy(snet)[0]);
    expect(xy(vm)[1]).toBeGreaterThan(xy(snet)[1]);
  });

  it("a missing node's badge reads Not deployed yet while deploying, on the cards and in the legend", () => {
    const { container, unmount } = draw(props({ status: { "lb-key": "missing" } }));
    expect(nodeEl(container, "lb")).toHaveTextContent("Not deployed or removed");
    unmount();
    const again = draw(props({ status: { "lb-key": "missing" }, deploying: true }));
    expect(nodeEl(again.container, "lb")).toHaveTextContent("Not deployed yet");
    fireEvent.click(screen.getByRole("button", { name: "Legend" }));
    expect(screen.getAllByText("Not deployed yet").length).toBeGreaterThan(1);
    expect(screen.queryByText("Not deployed or removed")).toBeNull();
  });

  it("the List view gets deploying too", () => {
    draw(props({ view: "list", status: { "lb-key": "missing" }, deploying: true }));
    expect(screen.getByRole("treeitem", { name: /lb-app/ })).toHaveTextContent("Not deployed yet");
  });

  it("colorMode follows the app theme", () => {
    const { container, unmount } = draw(props());
    expect(container.querySelector(".react-flow")).toHaveClass("dark");
    unmount();
    document.documentElement.setAttribute("data-theme", "light");
    const again = draw(props());
    expect(again.container.querySelector(".react-flow")).toHaveClass("light");
  });

  it("uses React Flow's base.css only", () => {
    expect(flowSource).toMatch(/import "@xyflow\/react\/dist\/base\.css";/);
    expect(flowSource).not.toMatch(/dist\/style\.css/);
  });

  it("clicking a node selects it; Enter on a focused node opens it too", () => {
    const onSelect = vi.fn();
    const { container } = draw(props({ onSelect }));
    fireEvent.click(nodeEl(container, "vm"));
    expect(onSelect).toHaveBeenLastCalledWith("vm");
    onSelect.mockClear();
    nodeEl(container, "lb").focus();
    fireEvent.keyDown(nodeEl(container, "lb"), { key: "Enter" });
    expect(onSelect).toHaveBeenLastCalledWith("lb");
  });

  it("arrow keys move a selected node and call onMove", () => {
    const onMove = vi.fn();
    const { container } = draw(props({ selected: "lb", onMove }));
    const laid = layoutTopology(graph, null).nodes.find((n) => n.id === "lb")!;
    const lb = nodeEl(container, "lb");
    lb.focus();
    fireEvent.keyDown(lb, { key: "ArrowRight" });
    expect(onMove).toHaveBeenCalledWith("lb-key", { x: laid.x + 5, y: laid.y, p: RG });
  });

  it("a drag end calls onMove with the relative position and parent key", () => {
    const onMove = vi.fn();
    const { container } = draw(props({ onMove }));
    const vm = nodeEl(container, "vm");
    const laid = layoutTopology(graph, null).nodes.find((n) => n.id === "vm")!;
    const view = vm.ownerDocument.defaultView!;
    // jsdom refuses `view` in the constructor here; d3-drag needs it to follow the mouse, so it is set afterwards.
    const mouse = (type: string, x: number, y: number) => {
      const e = new view.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
      Object.defineProperty(e, "view", { value: view });
      return e;
    };
    act(() => {
      vm.dispatchEvent(mouse("mousedown", 100, 100));
      view.dispatchEvent(mouse("mousemove", 130, 140));
      view.dispatchEvent(mouse("mousemove", 160, 180));
      view.dispatchEvent(mouse("mouseup", 160, 180));
    });
    expect(onMove).toHaveBeenCalledTimes(1);
    const [key, at] = onMove.mock.calls[0]!;
    expect(key).toBe("vm-key");
    expect(at.p).toBe("snet-key");
    expect(at.x).not.toBe(laid.x);
  });

  it("fit view on first render, and a fit is instant under reduced motion", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("prefers-reduced-motion"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
    const undo = measureFromStyle();
    try {
      const { container } = draw(props({ search: "vm-app" }));
      await waitFor(() => expect(viewport(container).replace(/\s/g, "")).not.toBe("translate(0px,0px)scale(1)"));
      const fitted = viewport(container);
      await act(async () => requestFit());
      // No transition: the view is at the matches as soon as the request is handled.
      expect(viewport(container)).not.toBe(fitted);
    } finally {
      undo();
    }
  });

  it("on the phone the first fit never shrinks cards past readable (zoom at least PHONE_MIN_FIT_ZOOM; pan for the rest)", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
    const undo = measureFromStyle();
    try {
      const { container } = render(
        <div style={{ width: 120, height: 120 }}>
          <Canvas {...props()} />
        </div>,
      );
      await waitFor(() => expect(viewport(container).replace(/\s/g, "")).not.toBe("translate(0px,0px)scale(1)"));
      const scale = Number(viewport(container).match(/scale\(([\d.]+)\)/)![1]);
      expect(scale).toBeGreaterThanOrEqual(PHONE_MIN_FIT_ZOOM);
      expect(PHONE_MIN_FIT_ZOOM).toBeGreaterThanOrEqual(0.4);
    } finally {
      undo();
    }
  });

  /** The canvas measured as a browser lays it out: `w` × `h`. */
  function sized(w: number, h: number) {
    const proto = HTMLElement.prototype;
    const had = Object.hasOwn(proto, "clientWidth");
    Object.defineProperty(proto, "clientWidth", { configurable: true, get(this: HTMLElement) { return this.classList.contains("topo-canvas") ? w : 0; } });
    Object.defineProperty(proto, "clientHeight", { configurable: true, get(this: HTMLElement) { return this.classList.contains("topo-canvas") ? h : 0; } });
    return () => {
      if (!had) Reflect.deleteProperty(proto, "clientWidth");
      if (!had) Reflect.deleteProperty(proto, "clientHeight");
    };
  }

  it("measured, the layout packs for the canvas's shape (the tab's, the full screen's)", () => {
    const undo = sized(550, 445);
    try {
      const { container } = draw(props());
      const want = layoutTopology(graph, null, { space: { w: quantiseLength(550), h: quantiseLength(445) - PANEL_RESERVE.tab } }).nodes.find((n) => n.id === "lb")!;
      const lb = nodeEl(container, "lb");
      expect(lb.style.transform.replace(/\s/g, "")).toBe(`translate(${want.x}px,${want.y}px)`);
      expect(quantiseLength(550)).toBe(quantiseLength(556));
    } finally {
      undo();
    }
  });

  it("on the phone a picture too big to read whole starts at its top-left at the readable zoom, not in the middle", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("max-width"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
    const undo = sized(120, 200);
    try {
      const { container } = draw(props({ variant: "full" }));
      expect(viewport(container).replace(/\s/g, "")).toBe(`translate(${START_INSET.left}px,${START_INSET.top}px)scale(${PHONE_MIN_FIT_ZOOM})`);
    } finally {
      undo();
    }
  });

  it("the mini variant has no pan, zoom, drag or edge labels", () => {
    const { container } = draw(props({ variant: "mini", onMove: undefined }));
    expect(container.querySelector(".react-flow__pane")).not.toHaveClass("draggable");
    expect(nodeEl(container, "vm")).not.toHaveClass("draggable");
    expect(screen.queryByText("TCP 80→80")).not.toBeInTheDocument();
    // Icons and names only.
    expect(screen.queryByText("Standard_B1s")).not.toBeInTheDocument();
    expect(screen.getByText("vm-app")).toBeInTheDocument();
  });

  it("the sprite is fetched once and inlined", async () => {
    draw(props());
    draw(props({ variant: "mini" }));
    await waitFor(() => expect(document.getElementById("az-virtual-machine")).not.toBeNull());
    expect(fetchMock.mock.calls.filter(([u]) => u === SPRITE_URL)).toHaveLength(1);
    // Inlined hidden, but not display:none (gradients would not render).
    const host = document.getElementById("topo-sprite")!;
    expect(host).toHaveAttribute("aria-hidden", "true");
    expect(host.innerHTML).not.toMatch(/display:\s*none/);
  });
});
