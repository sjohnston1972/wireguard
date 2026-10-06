// Lab topology plan T2: placements and persistence. The data behind every
// placement (planned when idle, live merged with ghosts while running, the
// planned fallback with a banner), the synced arrangement (the widgets' save
// discipline, per lab), the full-screen view and the badges end to end.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { LabSession } from "@shared/api";
import { makeQueryClient } from "@/api/queryClient";
import { resetConnection } from "@/api/connection";
import { mockFetch } from "@/test/mockFetch";
import { labSessionFixture } from "@/test/fixtures";
import { EXAMPLE_ADDRESSES_NOTE, useDiagramData } from "./data";
import { KEYS, LAB, LIVE_IDS, PLANNED_URL, TOPOLOGY_API, liveDown, liveOk, plannedGraph } from "./places.fixtures";

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
