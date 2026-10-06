// Lab topology plan T0.10: the diagram's route, the stub Canvas (the List view's tree until T1's React Flow canvas),
// and the dev-only /__topology/:id route.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import type { TopologyGraph } from "@shared/topology/model";
import { renderApp, renderWithProviders } from "@/test/render";
import { detailIdle, labs } from "../testData";
import { Canvas } from "./Canvas";
import diagram from "./index";
import type { CanvasProps } from "./contract";
import appSource from "@/App.tsx?raw";

vi.setConfig({ testTimeout: 20_000 });
beforeAll(async () => {
  await import("@/views/labs");
});

const ID = "az104-06-blob-security";
const L = "/subscriptions/00000000-0000-4000-8000-000000000000/resourcegroups/rg-lab-az104-06-blob-security";
const graph: TopologyGraph = {
  schema: 1,
  labId: ID,
  version: 1,
  source: "live",
  at: "2026-10-06T12:00:00.000Z",
  nodes: [
    { id: L, key: "microsoft.resources/resourcegroups/rg-lab-az104-06-blob-security", kind: "resourceGroup", label: "rg-lab-az104-06-blob-security", props: {} },
    { id: `${L}/vnet`, key: "microsoft.network/virtualnetworks/vnet-lab", kind: "vnet", label: "vnet-lab", parent: L, props: {} },
    { id: `${L}/vnet/snet`, key: "microsoft.network/virtualnetworks/subnets/vnet-lab/snet-app", kind: "subnet", label: "snet-app", parent: `${L}/vnet`, props: {} },
    { id: `${L}/vm`, key: "microsoft.compute/virtualmachines/vm-app", kind: "vm", label: "vm-app", parent: `${L}/vnet/snet`, props: {}, health: { tone: "ok", word: "Running" } },
    { id: `${L}/st`, key: "microsoft.storage/storageaccounts/{p}st", kind: "storage", label: "l06abcdest", parent: L, props: {}, health: { tone: "bad", word: "Failed" } },
    { id: `${L}/nsg`, key: "microsoft.network/networksecuritygroups/nsg-handmade", kind: "nsg", label: "nsg-handmade", parent: L, props: {} },
  ],
  edges: [],
};

const props = (over: Partial<CanvasProps> = {}): CanvasProps => ({
  graph,
  status: { "microsoft.network/networksecuritygroups/nsg-handmade": "added" },
  saved: null,
  view: "diagram",
  showDependencies: true,
  search: "",
  variant: "tab",
  selected: null,
  onSelect: () => {},
  ...over,
});

describe("the diagram's route", () => {
  it("/labs/:id/diagram renders the labs page", async () => {
    renderApp(`/labs/${ID}/diagram`, { routes: { "GET /api/v1/labs": labs(), [`GET /api/v1/labs/${ID}`]: detailIdle() } });
    expect(await within(await screen.findByRole("main")).findByRole("heading", { level: 1, name: "Labs" })).toBeInTheDocument();
    expect(await screen.findByRole("dialog", { name: /Blob security/ })).toBeInTheDocument();
    expect(screen.getByLabelText("location")).toHaveTextContent(`/labs/${ID}/diagram`);
  });
});

describe("the stub Canvas", () => {
  it("the stub Canvas renders the List view's tree with health words", () => {
    renderWithProviders(<Canvas {...props()} />, { routes: null });
    const tree = screen.getByRole("tree", { name: /diagram/i });
    const rg = within(tree).getByRole("treeitem", { name: /Resource group rg-lab-az104-06-blob-security/ });
    // Nested: group → VNet → subnet → VM.
    const vm = within(rg).getByRole("treeitem", { name: /VM vm-app/ });
    expect(vm).toHaveTextContent("Running");
    expect(within(rg).getByRole("treeitem", { name: /Subnet snet-app/ })).toContainElement(vm);
    expect(within(tree).getByRole("treeitem", { name: /Storage account l06abcdest/ })).toHaveTextContent("Failed");
    // The badge word for a hand-made resource.
    expect(within(tree).getByRole("treeitem", { name: /nsg-handmade/ })).toHaveTextContent("Added by hand");
  });

  it("the lazy chunk's default export is the three placements", () => {
    expect(Object.keys(diagram).sort()).toEqual(["DiagramTab", "FullScreen", "LabMini"]);
  });
});

describe("the dev-only /__topology/:id route", () => {
  it("draws a lab's planned graph in the tab, full and mini variants", async () => {
    const planned = { ...graph, source: "planned" as const, at: null };
    // The gallery reads the lab's hashed asset; in tests the asset map comes from the route's own URL map, so the
    // page is given one through its query string.
    renderApp(`/__topology/${ID}?asset=/assets/test-planned.json`, { routes: { "GET /assets/test-planned.json": planned } });
    for (const v of ["tab", "full", "mini"]) {
      const region = await screen.findByRole("region", { name: new RegExp(`${v} variant`, "i") });
      expect(within(region).getByRole("treeitem", { name: /VM vm-app/ })).toBeInTheDocument();
    }
  });

  it("is in the route table only under import.meta.env.DEV, like __gallery", () => {
    const app = appSource;
    expect(app).toMatch(/const TopologyGallery = import\.meta\.env\.DEV \? lazy\(\(\) => import\("@\/topologyGallery"\)\) : null;/);
    expect(app).toMatch(/\{TopologyGallery && \(/);
  });
});
