// Lab topology plan T1.2: big labs (spec ruling 19). Stacks of more than 8 of one kind, and the 300-node limits.
import { describe, expect, it } from "vitest";
import type { TopologyGraph, TopoNode, TopoKind, TopoPropValue, TopoEdge } from "@shared/topology/model";
import { LIST_VIEW_AT, STACK_AT } from "@shared/topology/kinds";
import { layoutTopology } from "./layout";
import { stackGraph, stackIdOf } from "./stacks";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { Canvas } from "./Canvas";

function n(id: string, kind: TopoKind, parent?: string, props: Record<string, TopoPropValue> = {}, extra: Partial<TopoNode> = {}): TopoNode {
  return { id, key: `k/${id}`, kind, label: id, props, ...(parent ? { parent } : {}), ...extra };
}
const g = (nodes: TopoNode[], edges: TopoEdge[] = []): TopologyGraph => ({ schema: 1, labId: "az104-09-vmss", version: 1, source: "live", at: "2026-10-06T12:00:00.000Z", nodes, edges });

function subnetWith(count: number, kind: TopoKind = "vm") {
  const nodes = [n("rg", "resourceGroup"), n("vnet", "vnet", "rg"), n("snet", "subnet", "vnet")];
  for (let i = 1; i <= count; i++) nodes.push(n(`vm${String(i).padStart(2, "0")}`, kind, "snet", { size: "Standard_B1s", privateIp: `10.71.192.${i + 3}` }, { health: { tone: i === 3 ? "bad" : "ok", word: i === 3 ? "Stopped" : "Running" } }));
  return nodes;
}

describe("stackGraph", () => {
  it(`stacks start above ${STACK_AT}`, () => {
    expect(STACK_AT).toBe(8);
    expect(stackGraph(g(subnetWith(8))).graph.nodes.filter((x) => x.kind === "vm")).toHaveLength(8);
  });

  it("9 VMs in a subnet become one stack card", () => {
    const { graph, stacks } = stackGraph(g(subnetWith(9)));
    const vms = graph.nodes.filter((x) => x.kind === "vm");
    expect(vms).toHaveLength(1);
    const card = vms[0]!;
    expect(card.id).toBe(stackIdOf("snet", "vm"));
    expect(card.parent).toBe("snet");
    expect(card.label).toBe("9 × VM");
    expect(card.key).toBe("stack/k/snet/vm");
    // Props every member shares are kept; ones that differ are not.
    expect(card.props).toEqual({ size: "Standard_B1s" });
    // The worst health, in words.
    expect(card.health).toEqual({ tone: "bad", word: "1 of 9 not OK" });
    expect(stacks[card.id]!.map((m) => m.id)).toEqual(["vm01", "vm02", "vm03", "vm04", "vm05", "vm06", "vm07", "vm08", "vm09"]);
  });

  it("only one kind in one container stacks", () => {
    const nodes = [...subnetWith(9), ...Array.from({ length: 4 }, (_, i) => n(`st${i}`, "storage", "rg"))];
    const { graph } = stackGraph(g(nodes));
    expect(graph.nodes.filter((x) => x.kind === "storage")).toHaveLength(4);
  });

  it("edges to members go to the stack, once", () => {
    const nodes = [...subnetWith(9), n("lb", "loadBalancer", "rg")];
    const edges: TopoEdge[] = Array.from({ length: 9 }, (_, i) => ({ id: `e${i}`, from: "lb", to: `vm${String(i + 1).padStart(2, "0")}`, kind: "traffic" as const, label: "TCP 80→80" }));
    const { graph } = stackGraph(g(nodes, edges));
    expect(graph.edges).toEqual([{ id: "e0", from: "lb", to: stackIdOf("snet", "vm"), kind: "traffic", label: "TCP 80→80" }]);
  });

  it("leaves a graph with no stack as it was", () => {
    const graph = g(subnetWith(3));
    expect(stackGraph(graph).graph).toBe(graph);
  });
});

describe("the 300 limit", () => {
  it(`a ${LIST_VIEW_AT}-node graph lays out under 50 ms`, () => {
    const nodes: TopoNode[] = [n("rg", "resourceGroup")];
    for (let v = 0; v < 6; v++) {
      nodes.push(n(`v${v}`, "vnet", "rg", { addressSpace: [`10.${v}.0.0/16`] }));
      for (let s = 0; s < 8; s++) {
        nodes.push(n(`v${v}s${s}`, "subnet", `v${v}`, { prefix: `10.${v}.${s}.0/24` }));
        for (let a = 0; a < 5; a++) nodes.push(n(`v${v}s${s}a${a}`, a % 2 ? "vm" : "privateEndpoint", `v${v}s${s}`));
      }
    }
    while (nodes.length < LIST_VIEW_AT) nodes.push(n(`x${nodes.length}`, "storage", "rg"));
    expect(nodes).toHaveLength(LIST_VIEW_AT);
    const graph = g(nodes);
    layoutTopology(graph, null, { aspect: null }); // warm up the JIT
    const t0 = performance.now();
    const r = layoutTopology(graph, null, { aspect: null });
    expect(performance.now() - t0).toBeLessThan(50);
    expect(r.nodes).toHaveLength(LIST_VIEW_AT);
    // The canonical packing every view draws (several packings tried): still quick.
    layoutTopology(graph, null);
    const t1 = performance.now();
    expect(layoutTopology(graph, null).nodes).toHaveLength(LIST_VIEW_AT);
    expect(performance.now() - t1).toBeLessThan(250);
  });
});

describe("over the limit", () => {
  it(`over ${LIST_VIEW_AT} nodes opens in List with a note, the diagram one click away`, async () => {
    const nodes: TopoNode[] = [n("rg", "resourceGroup")];
    while (nodes.length <= LIST_VIEW_AT) nodes.push(n(`st${String(nodes.length).padStart(3, "0")}`, "storage", "rg"));
    renderWithProviders(
      <div style={{ width: 800, height: 600 }}>
        <Canvas graph={g(nodes)} status={{}} saved={null} view="diagram" showDependencies search="" variant="tab" selected={null} onSelect={() => {}} />
      </div>,
      { routes: null },
    );
    const note = screen.getByRole("note");
    expect(note).toHaveTextContent(`${LIST_VIEW_AT + 1} resources`);
    expect(screen.getByRole("tree", { name: /diagram/i })).toBeInTheDocument();
    await userEvent.click(within(note).getByRole("button", { name: "Show the diagram" }));
    expect(screen.queryByRole("tree", { name: /diagram/i })).not.toBeInTheDocument();
  });
});
