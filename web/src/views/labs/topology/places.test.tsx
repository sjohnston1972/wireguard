// Lab topology plan T2: placements and persistence. The data behind every
// placement (planned when idle, live merged with ghosts while running, the
// planned fallback with a banner), the synced arrangement (the widgets' save
// discipline, per lab), the full-screen view and the badges end to end.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { LabSession } from "@shared/api";
import type { TopologyLayout } from "@shared/topology/layout";
import { makeQueryClient } from "@/api/queryClient";
import { resetConnection } from "@/api/connection";
import { mockFetch } from "@/test/mockFetch";
import { labSessionFixture } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render";
import { EXAMPLE_ADDRESSES_NOTE, useDiagramData } from "./data";
import { LAYOUT_SAVE_DELAY_MS, useTopologyLayout } from "./useTopologyLayout";
import { KEYS, LAB, LAYOUT_API, LIVE_IDS, PLANNED_URL, TOPOLOGY_API, layoutPage, layoutServer, liveDown, liveOk, plannedGraph } from "./places.fixtures";

vi.setConfig({ testTimeout: 20_000 });

function wrapper() {
  resetConnection();
  const client = makeQueryClient();
  client.setDefaultOptions({ ...client.getDefaultOptions(), queries: { ...client.getDefaultOptions().queries, retry: false, staleTime: 0 } });
  const W = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return { W, client };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const running = (over: Partial<LabSession> = {}) => labSessionFixture({ cidr: "10.64.0.0/18", ...over });
const nodeByKey = (g: { nodes: { key: string }[] } | null, key: string) => g?.nodes.find((n) => n.key === key);

describe("T2.1 the data hook", () => {
  it("idle: the planned graph with the example-addresses note", async () => {
    const f = mockFetch({ [`GET ${PLANNED_URL}`]: plannedGraph() });
    const { W } = wrapper();
    const r = renderHook(() => useDiagramData(LAB, null), { wrapper: W });
    expect(r.result.current.loading).toBe(true);
    await waitFor(() => expect(r.result.current.graph).not.toBeNull());
    const d = r.result.current;
    expect(d.source).toBe("planned");
    expect(d.live).toBe(false);
    expect(d.status).toEqual({});
    expect(d.banner).toBeNull();
    expect(d.note).toBe(EXAMPLE_ADDRESSES_NOTE);
    expect(EXAMPLE_ADDRESSES_NOTE).toBe("Example addresses (slot 31); each session gets its own /18.");
    // Slot 31's addresses, untouched.
    expect(nodeByKey(d.graph, KEYS.subnet)!).toMatchObject({ props: { prefix: "10.71.192.0/24" } });
    // Nothing is asked of the live view with no session.
    expect(f.calls.some((c) => c.url.startsWith(TOPOLOGY_API))).toBe(false);
  });

  it("running: live merged with ghosts, planned rebased to the session's slot for the Planned toggle", async () => {
    mockFetch({ [`GET ${PLANNED_URL}`]: plannedGraph(), [`GET ${TOPOLOGY_API}`]: liveOk() });
    const { W } = wrapper();
    const s = running();
    const r = renderHook(({ source }: { source: "live" | "planned" }) => useDiagramData(LAB, s, { source }), { wrapper: W, initialProps: { source: "live" } });
    await waitFor(() => expect(r.result.current.source).toBe("live"));
    let d = r.result.current;
    expect(d.live).toBe(true);
    expect(d.note).toBeNull();
    expect(d.banner).toBeNull();
    // The live nodes, the hand-made one badged, the deleted endpoint a ghost under the live subnet.
    expect(nodeByKey(d.graph, KEYS.nsg)).toMatchObject({ id: LIVE_IDS.nsg });
    expect(d.status[KEYS.nsg]).toBe("added");
    expect(nodeByKey(d.graph, KEYS.pe)).toMatchObject({ id: "tf:azurerm_private_endpoint.blob", parent: LIVE_IDS.subnet });
    expect(d.status[KEYS.pe]).toBe("missing");
    expect(d.status[KEYS.group]).toBe("unlisted");
    // The ghost's planned props carry the session's own addresses, not slot 31's.
    expect(JSON.stringify(d.graph)).not.toContain("10.71.192");

    r.rerender({ source: "planned" });
    await waitFor(() => expect(r.result.current.source).toBe("planned"));
    d = r.result.current;
    expect(d.status).toEqual({});
    expect(d.note).toBeNull(); // real numbers: no example note
    expect(nodeByKey(d.graph, KEYS.subnet)).toMatchObject({ id: "tf:azurerm_subnet.endpoints", props: { prefix: "10.64.0.0/24" } });
    expect(nodeByKey(d.graph, KEYS.vnet)).toMatchObject({ props: { addressSpace: ["10.64.0.0/20"] } });
  });

  for (const [status, message] of [
    ["no_azure", "Azure is not configured for this dashboard."],
    ["failed", "Azure Resource Graph refused the query (403)."],
    ["throttled", "Azure is throttling requests just now."],
  ] as const) {
    it(`${status}: the planned graph with the banner's words`, async () => {
      mockFetch({ [`GET ${PLANNED_URL}`]: plannedGraph(), [`GET ${TOPOLOGY_API}`]: liveDown(status, message) });
      const { W } = wrapper();
      const r = renderHook(() => useDiagramData(LAB, running()), { wrapper: W });
      await waitFor(() => expect(r.result.current.banner).not.toBeNull());
      const d = r.result.current;
      expect(d.banner).toBe(`${message} Showing the planned diagram.`);
      expect(d.source).toBe("planned");
      expect(d.live).toBe(true);
      expect(d.status).toEqual({});
      expect(nodeByKey(d.graph, KEYS.pe)).toMatchObject({ id: "tf:azurerm_private_endpoint.blob" });
      expect(nodeByKey(d.graph, KEYS.subnet)).toMatchObject({ props: { prefix: "10.64.0.0/24" } });
    });
  }

  it("throttled with the last cached graph shows that graph, with the banner", async () => {
    mockFetch({ [`GET ${PLANNED_URL}`]: plannedGraph(), [`GET ${TOPOLOGY_API}`]: { ...liveOk(), status: "throttled", message: "Azure is throttling requests just now." } });
    const { W } = wrapper();
    const r = renderHook(() => useDiagramData(LAB, running()), { wrapper: W });
    await waitFor(() => expect(r.result.current.source).toBe("live"));
    expect(r.result.current.banner).toBe("Azure is throttling requests just now. Showing the last live view.");
    expect(r.result.current.status[KEYS.nsg]).toBe("added");
  });

  it("the live request failing shows the planned graph with the reason", async () => {
    mockFetch({ [`GET ${PLANNED_URL}`]: plannedGraph(), [`GET ${TOPOLOGY_API}`]: { status: 500, json: { error: { code: "internal", message: "Something broke (reference ab12)." } } } });
    const { W } = wrapper();
    const r = renderHook(() => useDiagramData(LAB, running()), { wrapper: W });
    await waitFor(() => expect(r.result.current.banner).not.toBeNull());
    expect(r.result.current.banner).toBe("The live view did not load: Something broke (reference ab12). Showing the planned diagram.");
    expect(r.result.current.source).toBe("planned");
  });

  it("truncated adds its banner", async () => {
    mockFetch({ [`GET ${PLANNED_URL}`]: plannedGraph(), [`GET ${TOPOLOGY_API}`]: liveOk({ truncated: true }) });
    const { W } = wrapper();
    const r = renderHook(() => useDiagramData(LAB, running()), { wrapper: W });
    await waitFor(() => expect(r.result.current.source).toBe("live"));
    expect(r.result.current.banner).toBe("The lab has more than 1000 resources: showing the first 1000.");
  });

  it("deploying: the merge knows, so missing reads Not deployed yet", async () => {
    mockFetch({ [`GET ${PLANNED_URL}`]: plannedGraph(), [`GET ${TOPOLOGY_API}`]: liveOk() });
    const { W } = wrapper();
    const r = renderHook(() => useDiagramData(LAB, running({ state: "deploying" })), { wrapper: W });
    await waitFor(() => expect(r.result.current.source).toBe("live"));
    expect(r.result.current.deploying).toBe(true);
    expect(r.result.current.status[KEYS.pe]).toBe("missing");
  });

  it("the planned file failing to load shows an error with Try again", async () => {
    let fail = true;
    mockFetch({ [`GET ${PLANNED_URL}`]: () => (fail ? { status: 503, json: {} } : plannedGraph()) });
    const { W } = wrapper();
    const r = renderHook(() => useDiagramData(LAB, null), { wrapper: W });
    await waitFor(() => expect(r.result.current.error).not.toBeNull());
    expect(r.result.current.error).toBe("The planned diagram did not load (503).");
    expect(r.result.current.graph).toBeNull();
    expect(r.result.current.loading).toBe(false);
    fail = false;
    act(() => r.result.current.retry());
    await waitFor(() => expect(r.result.current.graph).not.toBeNull());
    expect(r.result.current.error).toBeNull();
  });
});

// ── T2.2 the saved arrangement ───────────────────────────────────────────

function LayoutProbe() {
  const l = useTopologyLayout(LAB);
  return (
    <div>
      <output aria-label="status">{l.status}</output>
      <output aria-label="layout">{JSON.stringify(l.saved)}</output>
      <output aria-label="note">{l.note ?? ""}</output>
      <button onClick={() => l.move(KEYS.nsg, { x: 10.4, y: 20.6, p: KEYS.rg })}>move nsg</button>
      <button onClick={() => l.move(KEYS.nsg, { x: 50, y: 60, p: KEYS.rg })}>move nsg again</button>
      <button onClick={() => l.move(KEYS.storage, { x: 300, y: 40, p: KEYS.rg })}>move storage</button>
      <button onClick={() => l.reset()}>reset</button>
    </div>
  );
}

const out = (name: string) => screen.getByRole("status", { name });
const shown = () => JSON.parse(out("layout").textContent || "null") as TopologyLayout | null;
const ready = () => waitFor(() => expect(out("status")).toHaveTextContent("ready"));

/** A promise the test resolves itself. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("T2.2 the saved arrangement", () => {
  it("a drag saves once after 600 ms", async () => {
    expect(LAYOUT_SAVE_DELAY_MS).toBe(600);
    const server = layoutServer(layoutPage({ [KEYS.zone]: { x: 1, y: 2, p: KEYS.rg } }, 3));
    renderWithProviders(<LayoutProbe />, { routes: server.routes });
    await ready();
    expect(shown()).toEqual({ v: 1, nodes: { [KEYS.zone]: { x: 1, y: 2, p: KEYS.rg } } });
    const before = performance.now();
    await userEvent.click(screen.getByRole("button", { name: "move nsg" }));
    await userEvent.click(screen.getByRole("button", { name: "move storage" }));
    // Shown at once, whole numbers.
    expect(shown()!.nodes[KEYS.nsg]).toEqual({ x: 10, y: 21, p: KEYS.rg });
    expect(server.puts).toHaveLength(0);
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(performance.now() - before).toBeGreaterThanOrEqual(LAYOUT_SAVE_DELAY_MS - 5);
    expect(server.puts[0]).toEqual({
      baseVersion: 3,
      layout: { v: 1, nodes: { [KEYS.zone]: { x: 1, y: 2, p: KEYS.rg }, [KEYS.nsg]: { x: 10, y: 21, p: KEYS.rg }, [KEYS.storage]: { x: 300, y: 40, p: KEYS.rg } } },
    });
    await new Promise((r) => setTimeout(r, LAYOUT_SAVE_DELAY_MS + 100));
    expect(server.puts).toHaveLength(1);
    expect(server.state.page.version).toBe(4);
    expect(shown()!.nodes[KEYS.storage]).toEqual({ x: 300, y: 40, p: KEYS.rg });
  });

  it("moves during a save are sent after it with the new version", async () => {
    const server = layoutServer(layoutPage({}, 1));
    const put = server.routes[`PUT ${LAYOUT_API}`] as (r: unknown) => unknown;
    const gate = deferred<void>();
    let calls = 0;
    server.routes[`PUT ${LAYOUT_API}`] = async (r: unknown) => {
      calls++;
      if (calls === 1) await gate.promise;
      return put(r);
    };
    renderWithProviders(<LayoutProbe />, { routes: server.routes });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "move nsg" }));
    await waitFor(() => expect(calls).toBe(1));
    await userEvent.click(screen.getByRole("button", { name: "move nsg again" }));
    expect(shown()!.nodes[KEYS.nsg]).toEqual({ x: 50, y: 60, p: KEYS.rg });
    await new Promise((r) => setTimeout(r, LAYOUT_SAVE_DELAY_MS + 100));
    expect(calls).toBe(1);
    await act(async () => gate.resolve());
    await waitFor(() => expect(server.puts).toHaveLength(2));
    expect(server.puts[1]).toEqual({ baseVersion: 2, layout: { v: 1, nodes: { [KEYS.nsg]: { x: 50, y: 60, p: KEYS.rg } } } });
    await waitFor(() => expect(server.state.page.version).toBe(3));
    expect(shown()!.nodes[KEYS.nsg]).toEqual({ x: 50, y: 60, p: KEYS.rg });
  });

  for (const [what, reply, said] of [
    ["500", { status: 500, json: { error: { code: "internal", message: "Something broke (reference ab12)." } } }, "Something broke (reference ab12)"],
    ["NetworkError", { networkError: true }, "Cannot reach the dashboard"],
  ] as const) {
    it(`a failed save reverts and toasts (${what})`, async () => {
      const server = layoutServer(layoutPage({ [KEYS.nsg]: { x: 5, y: 5, p: KEYS.rg } }, 1));
      server.routes[`PUT ${LAYOUT_API}`] = reply;
      renderWithProviders(<LayoutProbe />, { routes: server.routes });
      await ready();
      await userEvent.click(screen.getByRole("button", { name: "move nsg again" }));
      expect(shown()!.nodes[KEYS.nsg]).toEqual({ x: 50, y: 60, p: KEYS.rg });
      expect(await screen.findByText(new RegExp(`^Couldn't save the diagram layout: ${said.replace(/[()]/g, "\\$&")}[^]*\\. Put back as it was\\.$`))).toBeInTheDocument();
      expect(shown()!.nodes[KEYS.nsg]).toEqual({ x: 5, y: 5, p: KEYS.rg });
    });
  }

  it("a 409 refetches and says Changed on another device", async () => {
    const server = layoutServer(layoutPage({}, 1));
    renderWithProviders(<LayoutProbe />, { routes: server.routes });
    await ready();
    // Another device saves first.
    server.state.page = layoutPage({ [KEYS.storage]: { x: 900, y: 900, p: KEYS.rg } }, 2);
    await userEvent.click(screen.getByRole("button", { name: "move nsg" }));
    expect(await screen.findByText("Changed on another device. Showing the latest.")).toBeInTheDocument();
    await waitFor(() => expect(shown()).toEqual({ v: 1, nodes: { [KEYS.storage]: { x: 900, y: 900, p: KEYS.rg } } }));
    expect(server.puts).toHaveLength(1);
  });

  it("Reset layout saves an empty layout", async () => {
    const server = layoutServer(layoutPage({ [KEYS.nsg]: { x: 5, y: 5, p: KEYS.rg } }, 4));
    renderWithProviders(<LayoutProbe />, { routes: server.routes });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "reset" }));
    expect(shown()).toEqual({ v: 1, nodes: {} });
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]).toEqual({ baseVersion: 4, layout: { v: 1, nodes: {} } });
  });

  it("a layout that failed to load is never saved over and the note says so", async () => {
    const server = layoutServer();
    server.routes[`GET ${LAYOUT_API}`] = { status: 500, json: { error: { code: "internal", message: "D1 is down." } } };
    renderWithProviders(<LayoutProbe />, { routes: server.routes });
    await waitFor(() => expect(out("status")).toHaveTextContent("failed"));
    expect(out("note")).toHaveTextContent("The saved arrangement did not load, so changes made now will not be kept.");
    expect(shown()).toBeNull();
    // Dragging still works for the visit…
    await userEvent.click(screen.getByRole("button", { name: "move nsg" }));
    expect(shown()!.nodes[KEYS.nsg]).toEqual({ x: 10, y: 21, p: KEYS.rg });
    await userEvent.click(screen.getByRole("button", { name: "reset" }));
    expect(shown()).toEqual({ v: 1, nodes: {} });
    // …but nothing is sent.
    await new Promise((r) => setTimeout(r, LAYOUT_SAVE_DELAY_MS + 150));
    expect(server.puts).toHaveLength(0);
  });

  it("the hidden-tab flush sends the pending save, with keepalive", async () => {
    const server = layoutServer(layoutPage({}, 1));
    const { fetchMock } = renderWithProviders(<LayoutProbe />, { routes: server.routes });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "move nsg" }));
    const clickedAt = performance.now();
    const vis = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(performance.now() - clickedAt).toBeLessThan(LAYOUT_SAVE_DELAY_MS - 100);
    expect(fetchMock!.callsTo("PUT", LAYOUT_API)[0]!.init.keepalive).toBe(true);
    vis.mockRestore();
  });

  it("closing the diagram sends the pending save rather than dropping it", async () => {
    const server = layoutServer(layoutPage({}, 1));
    const r = renderWithProviders(<LayoutProbe />, { routes: server.routes });
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "move nsg" }));
    r.unmount();
    await waitFor(() => expect(server.puts).toHaveLength(1));
  });
});
