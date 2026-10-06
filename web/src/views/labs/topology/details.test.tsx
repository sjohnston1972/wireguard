// Lab topology plan T1.6: the details panel (spec §9.2).
import { describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { TopologyGraph, TopoNode } from "@shared/topology/model";
import { setViewport } from "@/test/viewport";
import { Details } from "./Details";
import { stackIdOf } from "./stacks";

const SUB = "/subscriptions/00000000-0000-4000-8000-000000000000/resourcegroups/rg-lab-az104-06-blob-security";
const vm: TopoNode = {
  id: `${SUB}/providers/microsoft.compute/virtualmachines/vm-app`,
  key: "microsoft.compute/virtualmachines/vm-app",
  kind: "vm",
  label: "vm-app",
  parent: "snet",
  armType: "Microsoft.Compute/virtualMachines",
  props: { size: "Standard_B1s", privateIp: "10.71.192.4", resourceId: `${SUB}/providers/Microsoft.Compute/virtualMachines/vm-app` },
  health: { tone: "ok", word: "Running" },
  folded: [{ id: "nic", label: "nic-vm-app", armType: "Microsoft.Network/networkInterfaces" }],
};
const live: TopologyGraph = {
  schema: 1,
  labId: "az104-06-blob-security",
  version: 2,
  source: "live",
  at: "2026-10-06T12:00:00.000Z",
  nodes: [
    { id: "rg", key: "rg", kind: "resourceGroup", label: "rg-lab-az104-06-blob-security", props: {} },
    { id: "vnet", key: "vnet", kind: "vnet", label: "vnet-lab", parent: "rg", props: {} },
    { id: "snet", key: "snet", kind: "subnet", label: "snet-app", parent: "vnet", props: { prefix: "10.71.192.0/24" } },
    vm,
    { id: "lb", key: "lb", kind: "loadBalancer", label: "lb-app", parent: "rg", props: {} },
    { id: "law", key: "law", kind: "logAnalytics", label: "law-lab", parent: "rg", props: {} },
    { id: "nsg", key: "nsg-key", kind: "nsg", label: "nsg-handmade", parent: "rg", props: {} },
  ],
  edges: [
    { id: "e1", from: "lb", to: vm.id, kind: "traffic", label: "TCP 80→80" },
    { id: "e2", from: vm.id, to: "law", kind: "dependency", label: "diagnostics" },
  ],
};

describe("Details", () => {
  it("lists props with copy buttons for IPs, connections in and out, folded resources", () => {
    render(<Details graph={live} status={{}} nodeId={vm.id} onClose={() => {}} />);
    const panel = screen.getByRole("complementary", { name: "vm-app" });
    expect(within(panel).getAllByText("VM").length).toBeGreaterThan(0);
    expect(within(panel).getByText("Microsoft.Compute/virtualMachines")).toBeInTheDocument();
    expect(within(panel).getByText("Running")).toBeInTheDocument();
    expect(within(panel).getByText("Standard_B1s")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Copy Private IP" })).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Copy Size" })).not.toBeInTheDocument();
    // Its group, inner first.
    expect(within(panel).getByText("snet-app in vnet-lab in rg-lab-az104-06-blob-security")).toBeInTheDocument();
    const conns = within(panel).getByRole("list", { name: "Connections" });
    expect(within(conns).getByText("From lb-app: TCP 80→80")).toBeInTheDocument();
    expect(within(conns).getByText("To law-lab: diagnostics (dependency)")).toBeInTheDocument();
    const folded = within(panel).getByRole("list", { name: "Drawn inside this card" });
    expect(within(folded).getByText("nic-vm-app")).toBeInTheDocument();
    // The resource id is the portal link's, not a row of its own.
    expect(within(panel).queryByText(/^\/subscriptions/)).not.toBeInTheDocument();
  });

  it("Open in Azure portal appears for live nodes only, with the resource id link", () => {
    const { unmount } = render(<Details graph={live} status={{}} nodeId={vm.id} onClose={() => {}} />);
    expect(screen.getByRole("link", { name: /Open in Azure portal/ })).toHaveAttribute("href", `https://portal.azure.com/#resource${SUB}/providers/Microsoft.Compute/virtualMachines/vm-app`);
    unmount();
    render(<Details graph={{ ...live, source: "planned", at: null }} status={{}} nodeId={vm.id} onClose={() => {}} />);
    expect(screen.queryByRole("link", { name: /Open in Azure portal/ })).not.toBeInTheDocument();
  });

  it("a ghost has no portal link", () => {
    render(<Details graph={live} status={{ [vm.key]: "missing" }} nodeId={vm.id} onClose={() => {}} />);
    expect(screen.queryByRole("link", { name: /Open in Azure portal/ })).not.toBeInTheDocument();
  });

  it("explains the badge", () => {
    render(<Details graph={live} status={{ "nsg-key": "added" }} nodeId="nsg" onClose={() => {}} />);
    expect(screen.getByText("Added by hand")).toBeInTheDocument();
    expect(screen.getByText(/not in the lab's Terraform/)).toBeInTheDocument();
  });

  it("a stack card lists its members in the details", () => {
    const nodes = [...live.nodes.filter((n) => n.id !== vm.id)];
    for (let i = 1; i <= 9; i++) nodes.push({ id: `vm${i}`, key: `vm${i}`, kind: "vm", label: `vm-web-${i}`, parent: "snet", props: { privateIp: `10.71.192.${i + 3}` }, health: { tone: "ok", word: "Running" } });
    render(<Details graph={{ ...live, nodes, edges: [] }} status={{}} nodeId={stackIdOf("snet", "vm")} onClose={() => {}} />);
    const members = screen.getByRole("list", { name: "Members" });
    expect(within(members).getAllByRole("listitem")).toHaveLength(9);
    expect(within(members).getByText("vm-web-9")).toBeInTheDocument();
  });

  it("Escape closes it and returns focus to the node", async () => {
    function Host() {
      const [id, setId] = useState<string | null>(null);
      return (
        <>
          <div className="react-flow__node" data-id={vm.id} tabIndex={0} onClick={() => setId(vm.id)}>
            vm-app card
          </div>
          <Details graph={live} status={{}} nodeId={id} onClose={() => setId(null)} />
        </>
      );
    }
    render(<Host />);
    await userEvent.click(screen.getByText("vm-app card"));
    const panel = screen.getByRole("complementary", { name: "vm-app" });
    within(panel).getByRole("button", { name: "Close" }).focus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("complementary", { name: "vm-app" })).not.toBeInTheDocument();
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(screen.getByText("vm-app card")).toHaveFocus();
  });

  it("on the phone it is a Sheet", () => {
    setViewport("phone");
    const onClose = vi.fn();
    render(<Details graph={live} status={{}} nodeId={vm.id} onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "vm-app" })).toBeInTheDocument();
  });

  it("renders nothing for no node or an unknown one", () => {
    const { container } = render(<Details graph={live} status={{}} nodeId="nope" onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
