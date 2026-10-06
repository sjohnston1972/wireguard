// Lab topology plan T1.7: toolbar, search and legend (spec §9.1-§9.2).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { useState } from "react";
import type { TopologyGraph } from "@shared/topology/model";
import { setViewport } from "@/test/viewport";
import { Toolbar } from "./Toolbar";
import { Legend } from "./Legend";
import { Canvas } from "./Canvas";
import type { CanvasProps, ToolbarProps } from "./contract";
import { useFitRequests } from "./fitBus";
import { installFlowStandIns } from "./flowTestEnv";

beforeAll(installFlowStandIns);
afterEach(() => vi.unstubAllGlobals());

const graph: TopologyGraph = {
  schema: 1,
  labId: "az104-06-blob-security",
  version: 1,
  source: "live",
  at: "2026-10-06T12:00:00.000Z",
  nodes: [
    { id: "rg", key: "rg", kind: "resourceGroup", label: "rg-lab-az104-06-blob-security", props: {} },
    { id: "st", key: "st", kind: "storage", label: "stblob", parent: "rg", props: { accountKind: "StorageV2" } },
    { id: "kv", key: "kv", kind: "keyVault", label: "kv-lab", parent: "rg", props: {} },
    { id: "nsg", key: "nsg", kind: "nsg", label: "nsg-handmade", parent: "rg", props: {} },
  ],
  edges: [{ id: "d1", from: "kv", to: "st", kind: "dependency", label: "role: Reader" }],
};

const canvas = (over: Partial<CanvasProps> = {}) => (
  <div style={{ width: 800, height: 600 }}>
    <Canvas graph={graph} status={{}} saved={null} view="diagram" showDependencies search="" variant="tab" selected={null} onSelect={() => {}} onMove={() => {}} {...over} />
  </div>
);
const reducedMotion = () =>
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("prefers-reduced-motion"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));

function ToolbarHost(over: Partial<ToolbarProps> = {}) {
  const [search, setSearch] = useState("");
  const [deps, setDeps] = useState(true);
  const [view, setView] = useState<"diagram" | "list">("diagram");
  return (
    <MemoryRouter>
      <Toolbar source={null} search={search} onSearch={setSearch} showDependencies={deps} onDependencies={setDeps} view={view} onView={setView} variant="tab" {...over} />
      <output aria-label="state">{JSON.stringify({ search, deps, view })}</output>
    </MemoryRouter>
  );
}

describe("search", () => {
  it("search dims non-matches and highlights matches", () => {
    const { container } = render(canvas({ search: "kv" }));
    const card = (id: string) => container.querySelector(`.react-flow__node[data-id="${id}"] [data-testid="topo-asset"]`)!;
    expect(card("kv")).toHaveClass("topo-card--match");
    expect(card("kv")).not.toHaveClass("topo-card--dim");
    expect(card("st")).toHaveClass("topo-card--dim");
    // The group holding a match is not dimmed.
    expect(container.querySelector('.react-flow__node[data-id="rg"] [data-testid="topo-group"]')).not.toHaveClass("topo-group--dim");
  });

  it("matches by kind word and prop value too", () => {
    const { container } = render(canvas({ search: "storagev2" }));
    expect(container.querySelector('.react-flow__node[data-id="st"] [data-testid="topo-asset"]')).toHaveClass("topo-card--match");
  });

  it("Enter in the search box asks the canvas to fit to the matches", async () => {
    const onFit = vi.fn();
    function Spy() {
      useFitRequests(onFit);
      return null;
    }
    render(
      <>
        <ToolbarHost />
        <Spy />
      </>,
    );
    await userEvent.type(screen.getByRole("searchbox", { name: "Search the diagram" }), "kv");
    expect(screen.getByLabelText("state")).toHaveTextContent('"search":"kv"');
    expect(onFit).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(onFit).toHaveBeenCalledTimes(1);
  });
});

describe("Toolbar", () => {
  it("has the dependency toggle and the Diagram/List choice", async () => {
    render(<ToolbarHost />);
    await userEvent.click(screen.getByRole("switch", { name: "Show dependencies" }));
    expect(screen.getByLabelText("state")).toHaveTextContent('"deps":false');
    await userEvent.click(screen.getByRole("radio", { name: "List" }));
    expect(screen.getByLabelText("state")).toHaveTextContent('"view":"list"');
  });

  it("shows Live/Planned only with a source, and Reset, Full screen and Close only when given", async () => {
    const onSource = vi.fn();
    const onReset = vi.fn();
    const onClose = vi.fn();
    const { unmount } = render(<ToolbarHost />);
    expect(screen.queryByRole("radiogroup", { name: "Diagram source" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset layout" })).not.toBeInTheDocument();
    unmount();
    render(<ToolbarHost source="live" onSource={onSource} onReset={onReset} onClose={onClose} fullScreenHref="/labs/az104-06-blob-security/diagram" />);
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Diagram source" })).getByRole("radio", { name: "Planned" }));
    expect(onSource).toHaveBeenCalledWith("planned");
    await userEvent.click(screen.getByRole("button", { name: "Reset layout" }));
    expect(onReset).toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Full screen" })).toHaveAttribute("href", "/labs/az104-06-blob-security/diagram");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("Legend", () => {
  it("the legend shows only the kinds present and the badges in use", () => {
    render(<Legend graph={graph} status={{ nsg: "added", st: "both" }} />);
    const legend = screen.getByRole("list", { name: "Kinds" });
    expect(within(legend).getByText("Storage account")).toBeInTheDocument();
    expect(within(legend).getByText("Key vault")).toBeInTheDocument();
    expect(within(legend).getByText("Resource group")).toBeInTheDocument();
    expect(within(legend).queryByText("VM")).not.toBeInTheDocument();
    const badges = screen.getByRole("list", { name: "Badges" });
    expect(within(badges).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Added by hand"]);
    // Only the edge styles in use: here a dependency, no traffic.
    const edges = screen.getByRole("list", { name: "Lines" });
    expect(within(edges).getByText(/Dependency/)).toBeInTheDocument();
    expect(within(edges).queryByText(/Traffic/)).not.toBeInTheDocument();
  });
});

describe("full-screen extras", () => {
  it("MiniMap and Controls appear in the full variant only", () => {
    const { container, unmount } = render(canvas({ variant: "tab" }));
    expect(container.querySelector(".react-flow__minimap")).toBeNull();
    expect(container.querySelector(".react-flow__controls")).toBeNull();
    unmount();
    const full = render(canvas({ variant: "full" }));
    expect(full.container.querySelector(".react-flow__minimap")).not.toBeNull();
    expect(full.container.querySelector(".react-flow__controls")).not.toBeNull();
  });

  it("no MiniMap on the phone", () => {
    setViewport("phone");
    const { container } = render(canvas({ variant: "full" }));
    expect(container.querySelector(".react-flow__minimap")).toBeNull();
    expect(container.querySelector(".react-flow__controls")).not.toBeNull();
  });

  it("Animate traffic is off by default and disabled under reduced motion", () => {
    const { unmount } = render(canvas({ variant: "full" }));
    expect(screen.getByRole("switch", { name: "Animate traffic" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Animate traffic" })).toBeEnabled();
    unmount();
    reducedMotion();
    render(canvas({ variant: "full" }));
    expect(screen.getByRole("switch", { name: "Animate traffic" })).toBeDisabled();
  });

  it("the tab variant has no Animate traffic switch", () => {
    render(canvas({ variant: "tab" }));
    expect(screen.queryByRole("switch", { name: "Animate traffic" })).not.toBeInTheDocument();
  });

  it("the legend opens from a button in the tab and full variants", async () => {
    render(canvas({ variant: "tab" }));
    expect(screen.queryByRole("list", { name: "Kinds" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Legend" }));
    expect(screen.getByRole("list", { name: "Kinds" })).toBeInTheDocument();
  });
});
