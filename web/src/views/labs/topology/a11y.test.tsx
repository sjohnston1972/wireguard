// Lab topology plan T1.8: accessibility and the List view (spec §9.3). No axe in the repo, so role and name checks.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TopologyGraph } from "@shared/topology/model";
import { Canvas } from "./Canvas";
import { ListView } from "./ListView";
import type { CanvasProps } from "./contract";
import { edgeName, nodeIndex, nodeName } from "./words";
import { installFlowStandIns } from "./flowTestEnv";

beforeAll(installFlowStandIns);

const graph: TopologyGraph = {
  schema: 1,
  labId: "az700-43-private-link",
  version: 3,
  source: "live",
  at: "2026-10-06T12:00:00.000Z",
  nodes: [
    { id: "rg", key: "rg", kind: "resourceGroup", label: "rg-lab-az700-43-private-link", props: { region: "uksouth" } },
    { id: "vnet", key: "vnet", kind: "vnet", label: "vnet-lab", parent: "rg", props: { addressSpace: ["10.64.0.0/16"] } },
    { id: "snet", key: "snet", kind: "subnet", label: "snet-app", parent: "vnet", props: { prefix: "10.64.0.0/24" } },
    { id: "vm", key: "vm", kind: "vm", label: "vm-app", parent: "snet", props: { size: "Standard_B1s", privateIp: "10.64.0.4" }, health: { tone: "ok", word: "Running" } },
    { id: "lb", key: "lb", kind: "loadBalancer", label: "lb-svc", parent: "snet", props: { privateIp: "10.64.0.10" } },
    { id: "pe", key: "pe", kind: "privateEndpoint", label: "pe-svc", parent: "snet", props: { groupId: "blob" } },
    { id: "st", key: "st", kind: "storage", label: "stsvc", parent: "rg", props: { accountKind: "StorageV2" } },
    { id: "law", key: "law", kind: "logAnalytics", label: "law-lab", parent: "rg", props: {} },
  ],
  edges: [
    { id: "e1", from: "lb", to: "vm", kind: "traffic", label: "TCP 80→80" },
    { id: "e2", from: "pe", to: "st", kind: "traffic", label: "blob", state: { tone: "warn", word: "Pending approval" } },
    { id: "e3", from: "vm", to: "law", kind: "dependency", label: "diagnostics" },
  ],
};
const byId = nodeIndex(graph);
const props = (over: Partial<CanvasProps> = {}): CanvasProps => ({ graph, status: { st: "added" }, saved: null, view: "diagram", showDependencies: true, search: "", variant: "tab", selected: null, onSelect: () => {}, onMove: () => {}, ...over });

describe("names", () => {
  it("every node has an accessible name with kind, name, parent, health and key prop", () => {
    expect(nodeName(byId.get("vm")!, byId.get("snet"), null)).toBe("VM vm-app in snet-app, Running, private IP 10.64.0.4");
    expect(nodeName(byId.get("snet")!, byId.get("vnet"), null)).toBe("Subnet snet-app in vnet-lab, prefix 10.64.0.0/24");
    expect(nodeName(byId.get("rg")!, undefined, null)).toBe("Resource group rg-lab-az700-43-private-link, region uksouth");
    expect(nodeName(byId.get("st")!, byId.get("rg"), "Added by hand")).toBe("Storage account stsvc in rg-lab-az700-43-private-link, Added by hand, account kind StorageV2");
  });

  it("traffic edges have names, with their state", () => {
    expect(edgeName(graph.edges[0]!, byId)).toBe("lb-svc to vm-app: TCP 80→80");
    expect(edgeName(graph.edges[1]!, byId)).toBe("pe-svc to stsvc: blob, Pending approval");
  });

  it("the canvas gives every node and traffic edge its name", () => {
    render(
      <div style={{ width: 800, height: 600 }}>
        <Canvas {...props()} />
      </div>,
    );
    for (const id of ["vm", "snet", "rg", "lb", "pe", "st", "law", "vnet"]) {
      const n = byId.get(id)!;
      const name = nodeName(n, n.parent ? byId.get(n.parent) : undefined, id === "st" ? "Added by hand" : null);
      expect(screen.getByRole("group", { name })).toHaveAttribute("tabindex", "0");
    }
    expect(screen.getByRole("group", { name: "pe-svc to stsvc: blob, Pending approval" })).toHaveAttribute("tabindex", "0");
  });
});

describe("the List view", () => {
  it("the List tree has the same words and connections", () => {
    render(<ListView graph={graph} status={{ st: "added" }} />);
    const tree = screen.getByRole("tree", { name: /diagram/i });
    const vm = within(tree).getByRole("treeitem", { name: "VM vm-app in snet-app, Running, private IP 10.64.0.4" });
    expect(vm).toHaveAccessibleDescription("Connections: from lb-svc: TCP 80→80; to law-lab: diagnostics (dependency)");
    expect(within(tree).getByRole("treeitem", { name: /^Storage account stsvc .*Added by hand/ })).toHaveTextContent("Added by hand");
    expect(within(tree).getByRole("treeitem", { name: /^Private endpoint pe-svc/ })).toHaveAccessibleDescription("Connections: to stsvc: blob, Pending approval");
    // Nested as on the canvas.
    expect(within(tree).getByRole("treeitem", { name: /^Subnet snet-app/ })).toContainElement(vm);
  });

  it("is one tab stop; arrows move, Enter selects, Left collapses and Right expands", async () => {
    const onSelect = vi.fn();
    render(<ListView graph={graph} status={{}} onSelect={onSelect} />);
    const items = screen.getAllByRole("treeitem");
    expect(items.filter((i) => i.tabIndex === 0)).toHaveLength(1);
    const rg = screen.getByRole("treeitem", { name: /^Resource group/ });
    rg.focus();
    await userEvent.keyboard("{ArrowDown}");
    // Inside the group: the VNet comes first (groups before resources), then the loose resources.
    expect(screen.getByRole("treeitem", { name: /^Virtual network vnet-lab/ })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith("vnet");
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("treeitem", { name: /^Virtual network vnet-lab/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("treeitem", { name: /^Subnet snet-app/ })).not.toBeInTheDocument();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("treeitem", { name: /^Subnet snet-app/ })).toBeInTheDocument();
    await userEvent.keyboard("{End}");
    expect(screen.getAllByRole("treeitem").at(-1)).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(rg).toHaveFocus();
  });

  it("search highlights matches in the list too", () => {
    render(<ListView graph={graph} status={{}} search="stsvc" />);
    expect(screen.getByRole("treeitem", { name: /^Storage account stsvc/ })).toHaveClass("topo-list__item--match");
  });
});

describe("role and name checks (no axe in the repo)", () => {
  for (const variant of ["tab", "full"] as const) {
    it(`every control and node in the ${variant} variant has a name, and ids are unique`, () => {
      const { container } = render(
        <div style={{ width: 800, height: 600 }}>
          <Canvas {...props({ variant })} />
        </div>,
      );
      for (const role of ["button", "link", "switch", "group", "region"]) for (const el of screen.queryAllByRole(role)) expect(el).toHaveAccessibleName();
      const ids = [...container.querySelectorAll("[id]")].map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      // Every focusable thing is a named control or node.
      for (const el of container.querySelectorAll<HTMLElement>('[tabindex="0"], button, a[href]')) expect(el).toHaveAccessibleName();
    });
  }
});
