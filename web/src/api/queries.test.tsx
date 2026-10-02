import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ApiError, NetworkError, SessionExpiredError } from "./client";
import { makeQueryClient, shouldRetry, retryDelay } from "./queryClient";
import { INTERVALS, activityInterval, overviewInterval, useActivity, useClients, useCost, useHistory, useOverview, useSession, useSettings } from "./queries";
import { resetConnection } from "./connection";
import { mockFetch } from "@/test/mockFetch";

function wrapper() {
  const client = makeQueryClient();
  const W = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { W, client };
}

beforeEach(() => resetConnection());
afterEach(() => vi.unstubAllGlobals());

const snap = (state: string) => ({ snapshot: { state } });

describe("refresh intervals", () => {
  it("polls the overview every 15 s when nothing is happening", () => {
    expect(overviewInterval(snap("running") as never)).toBe(15_000);
    expect(overviewInterval(snap("destroyed") as never)).toBe(15_000);
    expect(overviewInterval(snap("standby") as never)).toBe(15_000);
    expect(overviewInterval(undefined)).toBe(15_000);
  });

  it.each(["deploying", "destroying", "hibernating", "resuming"])("polls every 5 s while %s", (state) => {
    expect(overviewInterval(snap(state) as never)).toBe(5_000);
  });

  it("the constants follow the spec", () => {
    expect(INTERVALS).toMatchObject({ overview: 15_000, busy: 5_000, clients: 15_000, firewall: 15_000, activity: 30_000, cost: 60_000, settings: 60_000, history: 60_000 });
  });

  it("activity polls every 30 s", () => {
    expect(activityInterval()).toBe(30_000);
  });

  it("the overview hook switches from 15 s to 5 s when the data says a run is in progress", async () => {
    mockFetch({ "GET /api/v1/overview": snap("deploying") });
    const { W, client } = wrapper();
    renderHook(() => useOverview(), { wrapper: W });
    await waitFor(() => expect(client.getQueryData(["overview"])).toBeDefined());
    const q = client.getQueryCache().find({ queryKey: ["overview"] })!;
    const interval = q.observers[0]!.options.refetchInterval as (q: unknown) => number;
    expect(interval(q)).toBe(5_000);
    client.setQueryData(["overview"], snap("running"));
    expect(interval(q)).toBe(15_000);
  });

  it("the other hooks carry their intervals", async () => {
    mockFetch({
      "GET /api/v1/clients": { clients: [] },
      "GET /api/v1/cost": {},
      "GET /api/v1/settings": {},
      "GET /api/v1/session": {},
      "GET /api/v1/history": {},
      "GET /api/v1/activity": {},
    });
    const { W, client } = wrapper();
    renderHook(
      () => {
        useClients();
        useCost("month");
        useSettings();
        useSession();
        useHistory({ scope: "vm", range: "1h" });
        useActivity({ range: "24h" });
      },
      { wrapper: W },
    );
    const intervals = Object.fromEntries(client.getQueryCache().getAll().map((q) => [String(q.queryKey[0]), q.observers[0]!.options.refetchInterval]));
    expect(intervals).toMatchObject({ clients: 15_000, cost: 60_000, settings: 60_000, session: 60_000, history: 60_000, activity: 30_000 });
    for (const q of client.getQueryCache().getAll()) expect(q.observers[0]!.options.refetchIntervalInBackground).toBeFalsy();
  });
});

describe("retry policy", () => {
  it("never retries a 4xx or an expired session", () => {
    expect(shouldRetry(0, new ApiError(404, "not_found", "No."))).toBe(false);
    expect(shouldRetry(0, new ApiError(422, "confirm_required", "No."))).toBe(false);
    expect(shouldRetry(0, new SessionExpiredError())).toBe(false);
  });
  it("retries a network failure or a 5xx a few times", () => {
    expect(shouldRetry(0, new NetworkError())).toBe(true);
    expect(shouldRetry(2, new ApiError(502, "upstream", "x"))).toBe(true);
    expect(shouldRetry(3, new NetworkError())).toBe(false);
  });
  it("backs off exponentially up to 30 s", () => {
    expect([0, 1, 2, 3].map(retryDelay)).toEqual([1000, 2000, 4000, 8000]);
    expect(retryDelay(10)).toBe(30_000);
  });
});

describe("query hooks", () => {
  it("build their URLs from parameters", async () => {
    const m = mockFetch({
      "GET /api/v1/history": {},
      "GET /api/v1/activity": {},
      "GET /api/v1/cost": {},
      "GET /api/v1/clients/7": {},
      "GET /api/v1/runs/r1": { active: false },
      "GET /api/v1/runs/r1/log": { log: "" },
      "GET /api/v1/push/status": {},
    });
    const { W } = wrapper();
    const mod = await import("./queries");
    renderHook(
      () => {
        mod.useHistory({ scope: "client", id: 3, range: "7d" });
        mod.useActivity({ range: "7d", kind: "run", q: "a b", page: 2 });
        mod.useCost("30d");
        mod.useClient(7);
        mod.useRun("r1");
        mod.useRunLog("r1");
        mod.usePushStatus("https://push/x y");
      },
      { wrapper: W },
    );
    await waitFor(() => expect(m.calls.length).toBe(7));
    const urls = m.calls.map((c) => c.url).sort();
    expect(urls).toEqual(
      [
        "/api/v1/activity?range=7d&kind=run&q=a+b&page=2",
        "/api/v1/clients/7",
        "/api/v1/cost?range=30d",
        "/api/v1/history?scope=client&id=3&range=7d",
        "/api/v1/push/status?endpoint=https%3A%2F%2Fpush%2Fx+y",
        "/api/v1/runs/r1",
        "/api/v1/runs/r1/log",
      ].sort(),
    );
  });

  it("returns typed data and an error for a refusal without retrying a 404", async () => {
    const m = mockFetch({ "GET /api/v1/clients/9": { status: 404, json: { error: { code: "not_found", message: "No such client." } } } });
    const { W } = wrapper();
    const mod = await import("./queries");
    const { result } = renderHook(() => mod.useClient(9), { wrapper: W });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(ApiError);
    expect(m.calls.length).toBe(1);
  });

  it("is disabled when told to be", () => {
    const m = mockFetch({});
    const { W } = wrapper();
    renderHook(() => useClients({ enabled: false }), { wrapper: W });
    expect(m.calls.length).toBe(0);
  });
});
