// The lab diagram's data hooks (lab topology plan T0.10): the planned graph as a hashed asset, the live graph while a
// session runs, and the saved arrangement.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import type { TopologyGraph } from "@shared/topology/model";
import type { LabTopologyResponse } from "@shared/api";
import { makeQueryClient } from "./queryClient";
import { resetConnection } from "./connection";
import { mockFetch } from "@/test/mockFetch";
import { PLANNED_URLS, plannedTopologyUrl, putTopologyLayout, useLabTopology, usePlannedTopology, useTopologyLayoutQuery, TOPOLOGY_REFRESH_MS } from "./topology";

const ID = "az104-13-vnets";
const graph: TopologyGraph = { schema: 1, labId: ID, version: 3, source: "planned", at: null, nodes: [], edges: [] };
const live: LabTopologyResponse = { status: "ok", message: null, live: { ...graph, source: "live", at: "2026-10-06T12:00:00.000Z" }, fetchedAt: "2026-10-06T12:00:00.000Z", truncated: false };

function wrapper() {
  resetConnection();
  const client = makeQueryClient();
  client.setDefaultOptions({ ...client.getDefaultOptions(), queries: { ...client.getDefaultOptions().queries, retry: false } });
  const W = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return { W, client };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

describe("usePlannedTopology", () => {
  it("usePlannedTopology fetches the lab's hashed asset once and caches it", async () => {
    const urls = { [ID]: "/assets/az104-13-vnets-AbC123.json" };
    const f = mockFetch({ "GET /assets/az104-13-vnets-AbC123.json": graph });
    const { W } = wrapper();
    const a = renderHook(() => usePlannedTopology(ID, urls), { wrapper: W });
    await waitFor(() => expect(a.result.current.data).toEqual(graph));
    // A second user of the same lab reads the cache.
    const b = renderHook(() => usePlannedTopology(ID, urls), { wrapper: W });
    expect(b.result.current.data).toEqual(graph);
    a.rerender();
    expect(f.calls.filter((c) => c.url.startsWith("/assets/"))).toHaveLength(1);
    // Never through /api/v1: a static asset.
    expect(f.calls.every((c) => !c.url.startsWith("/api/"))).toBe(true);
  });

  it("a lab with no planned asset is an error, not an empty diagram", async () => {
    mockFetch({});
    const { W } = wrapper();
    const r = renderHook(() => usePlannedTopology("az104-99-nothing", {}), { wrapper: W });
    await waitFor(() => expect(r.result.current.isError).toBe(true));
  });

  it("plannedTopologyUrl maps a lab id to its asset, null for none", () => {
    expect(plannedTopologyUrl("az104-99-nothing")).toBeNull();
    for (const [id, url] of Object.entries(PLANNED_URLS)) {
      expect(id).toMatch(/^az\d{3}-\d{2}-/);
      expect(plannedTopologyUrl(id)).toBe(url);
    }
  });
});

describe("useLabTopology", () => {
  it("useLabTopology is off without a live session and refetches every 30 s only while mounted and visible", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const f = mockFetch({ [`GET /api/v1/labs/${ID}/topology`]: live });
    const count = () => f.calls.filter((c) => c.url === `/api/v1/labs/${ID}/topology`).length;
    const { W } = wrapper();
    expect(TOPOLOGY_REFRESH_MS).toBe(30_000);

    // No live session: nothing is asked.
    const off = renderHook(() => useLabTopology(ID, { enabled: false }), { wrapper: W });
    await act(async () => vi.advanceTimersByTimeAsync(65_000));
    expect(count()).toBe(0);
    off.unmount();

    const on = renderHook(() => useLabTopology(ID, { enabled: true }), { wrapper: W });
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(count()).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(count()).toBe(2);
    expect(on.result.current.data).toEqual(live);

    // Hidden tab: no polling.
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => {
      window.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(95_000);
    });
    expect(count()).toBe(2);

    // Unmounted: no polling either.
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    on.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(95_000));
    const after = count();
    await act(async () => vi.advanceTimersByTimeAsync(95_000));
    expect(count()).toBe(after);
  });
});

describe("saved layouts", () => {
  it("putTopologyLayout sends baseVersion and the layout", async () => {
    const page = { version: 4, updatedAt: "2026-10-06T12:00:00.000Z", layout: { v: 1 as const, nodes: { "wg/gateway": { x: 10, y: 20, p: null } } } };
    const f = mockFetch({ [`PUT /api/v1/prefs/topology/${ID}`]: page });
    const out = await putTopologyLayout(ID, { baseVersion: 3, layout: page.layout });
    expect(out).toEqual(page);
    const put = f.calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe(`/api/v1/prefs/topology/${ID}`);
    expect(put.body).toEqual({ baseVersion: 3, layout: page.layout });
    // keepalive for a save sent as the tab hides.
    await putTopologyLayout(ID, { baseVersion: 4, layout: page.layout }, { keepalive: true });
    expect(f.calls.at(-1)!.init.keepalive).toBe(true);
  });

  it("useTopologyLayoutQuery reads the lab's saved arrangement", async () => {
    const page = { version: 0, updatedAt: null, layout: { v: 1, nodes: {} } };
    mockFetch({ [`GET /api/v1/prefs/topology/${ID}`]: page });
    const { W } = wrapper();
    const r = renderHook(() => useTopologyLayoutQuery(ID), { wrapper: W });
    await waitFor(() => expect(r.result.current.data).toEqual(page));
  });
});
