// Lab topology plan T1.3: group and asset cards (spec §9.2).
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { TopoNode } from "@shared/topology/model";
import { badgeOf, type NodeDiffStatus } from "@shared/topology/diff";
import { AssetCard } from "./nodes/AssetCard";
import { GroupCard } from "./nodes/GroupCard";
import { propText } from "./words";

const rg: TopoNode = {
  id: "tf:azurerm_resource_group.secondary",
  key: "microsoft.resources/resourcegroups/rg-lab-az700-40-lb-advanced-ukw",
  kind: "resourceGroup",
  label: "rg-lab-az700-40-lb-advanced-ukw",
  props: { region: "ukwest", tags: ["lab: az700-40-lb-advanced", "project: wg-admin-labs", "+1 tag"], chips: ["secondary"] },
};
const subnet: TopoNode = {
  id: "snet",
  key: "microsoft.network/virtualnetworks/subnets/vnet-lab/snet-app",
  kind: "subnet",
  label: "snet-app",
  parent: "vnet",
  props: { prefix: "10.71.192.0/24", chips: ["NSG nsg-app", "route table rt-app", "delegation Microsoft.ContainerInstance/containerGroups"] },
};
const vm: TopoNode = {
  id: "vm",
  key: "microsoft.compute/virtualmachines/vm-app",
  kind: "vm",
  label: "vm-app",
  parent: "snet",
  props: { size: "Standard_B1s", privateIp: "10.71.192.4", os: "Linux" },
  health: { tone: "ok", word: "Running" },
};
const db: TopoNode = { id: "db", key: "microsoft.sql/servers/databases/sql-x/db", kind: "sqlDatabase", label: "sqldb-app", props: { sku: "Basic", status: "Online" }, health: { tone: "ok", word: "Online" } };

describe("GroupCard", () => {
  it("an RG shows region, role and tag chips", () => {
    render(<GroupCard node={rg} badge={null} />);
    const card = screen.getByTestId("topo-group");
    expect(within(card).getByText("rg-lab-az700-40-lb-advanced-ukw")).toBeInTheDocument();
    for (const chip of ["ukwest", "secondary", "lab: az700-40-lb-advanced", "project: wg-admin-labs", "+1 tag"]) expect(within(card).getByText(chip)).toHaveClass("topo-chip");
    expect(card).toHaveClass("topo-group--resourceGroup");
  });

  it("a subnet shows its prefix and NSG, route table and delegation chips", () => {
    render(<GroupCard node={subnet} badge={null} />);
    const card = screen.getByTestId("topo-group");
    expect(within(card).getByText("10.71.192.0/24")).toBeInTheDocument();
    for (const chip of ["NSG nsg-app", "route table rt-app", "delegation Microsoft.ContainerInstance/containerGroups"]) expect(within(card).getByText(chip)).toHaveClass("topo-chip");
  });

  it("a VNet shows its address space and the gateway marker", () => {
    render(<GroupCard node={{ id: "v", key: "v", kind: "vnet", label: "vnet-hub", props: { addressSpace: ["10.71.192.0/20"], peerTarget: true } }} badge={null} />);
    expect(screen.getByText("10.71.192.0/20")).toBeInTheDocument();
    expect(screen.getByText("Peered to the gateway")).toHaveClass("topo-chip");
  });
});

describe("AssetCard", () => {
  it("an asset card shows icon, name, type word, its KINDS card props and a health word", () => {
    const { container } = render(<AssetCard node={vm} badge={null} />);
    const card = screen.getByTestId("topo-asset");
    expect(container.querySelector("use")).toHaveAttribute("href", "#az-virtual-machine");
    expect(within(card).getByText("vm-app")).toHaveAttribute("title", "vm-app");
    expect(within(card).getByText("VM")).toBeInTheDocument();
    // KINDS.vm.cardProps: size, private IP (os is not a card prop).
    expect(within(card).getByText("Standard_B1s")).toBeInTheDocument();
    expect(within(card).getByText("10.71.192.4")).toBeInTheDocument();
    expect(within(card).queryByText("Linux")).not.toBeInTheDocument();
    expect(within(card).getByText("Running")).toHaveClass("topo-health--ok");
  });

  it("a card without health says nothing about it, never a colour alone", () => {
    render(<AssetCard node={{ ...vm, health: undefined }} badge={null} />);
    expect(screen.getByTestId("topo-asset").querySelector(".topo-health")).toBeNull();
  });

  it("databases show status as the large chip", () => {
    render(<AssetCard node={db} badge={null} />);
    const status = screen.getByText("Online");
    expect(status).toHaveClass("topo-health", "topo-health--large", "topo-health--ok");
    // Shown once: the status prop is the large chip, not a small prop as well.
    expect(screen.getAllByText("Online")).toHaveLength(1);
  });

  it("badges read Added by hand, Made by Azure, Not deployed or removed, Not listed by the live view", () => {
    const words: string[] = [];
    for (const s of ["added", "azure", "missing", "unlisted"] as NodeDiffStatus[]) {
      const { unmount } = render(<AssetCard node={vm} badge={badgeOf(s)} ghost={s === "missing" || s === "unlisted"} />);
      words.push(screen.getByTestId("topo-badge").textContent ?? "");
      unmount();
    }
    expect(words).toEqual(["Added by hand", "Made by Azure", "Not deployed or removed", "Not listed by the live view"]);
  });

  it("ghosts are dashed and faded", () => {
    render(<AssetCard node={vm} badge="Not deployed or removed" ghost />);
    expect(screen.getByTestId("topo-asset")).toHaveClass("topo-card--ghost");
  });

  it("a stack card shows its count as its name", () => {
    render(<AssetCard node={{ ...vm, id: "stack:snet/vm", label: "12 × VM" }} badge={null} />);
    expect(screen.getByText("12 × VM")).toBeInTheDocument();
  });

  it("the mini variant shows icon and name only", () => {
    render(<AssetCard node={vm} badge={null} compact />);
    expect(screen.getByText("vm-app")).toBeInTheDocument();
    expect(screen.queryByText("Standard_B1s")).not.toBeInTheDocument();
    expect(screen.queryByText("Running")).not.toBeInTheDocument();
  });
});

describe("propText", () => {
  it("writes values plainly", () => {
    expect(propText("addressSpace", ["10.0.0.0/16", "10.1.0.0/16"])).toBe("10.0.0.0/16, 10.1.0.0/16");
    expect(propText("publicAccess", true)).toBe("on");
    expect(propText("publicAccess", false)).toBe("off");
    expect(propText("instances", 2)).toBe("2");
  });
});
