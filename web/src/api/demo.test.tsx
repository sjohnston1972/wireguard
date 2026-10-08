// Demo mode's hooks (spec 2026-10-08-demo-mode-design.md §7, §8): the switch,
// the refresh, the dev seeder, and "is demo on" for the views.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, useQuery, type QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { DEMO_REFUSED_MESSAGE } from "@shared/demo";
import { apiGet, currentSource, resetSource, switchSource } from "./client";
import { resetConnection } from "./connection";
import { testQueryClient } from "@/test/render";
import { ToastProvider } from "@/components/feedback/Toast";
import { mockFetch } from "@/test/mockFetch";
import { demoStatusFixture } from "@/test/fixtures";
import { useDemo, useDemoOn, useRefreshDemo, useSetDemo, useSourceChangeReset } from "./demo";
import { DEV_SEED_404, useDevSeed } from "./devSeed";

const from = (source: "real" | "demo", json: unknown, status = 200) =>
  new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json", "X-WG-Data": source } });

function setup() {
  const client = testQueryClient();
  const W = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
  return { client, W };
}

function seedCache(client: QueryClient) {
  client.setQueryData(["overview"], { real: true });
  client.setQueryData(["clients"], { real: true });
  client.setQueryData(["labs", "az104"], { real: true });
}
const cached = (client: QueryClient) => client.getQueryCache().getAll().filter((q) => q.state.data !== undefined).map((q) => JSON.stringify(q.queryKey));

beforeEach(() => {
  resetConnection();
  resetSource();
});
afterEach(() => vi.unstubAllGlobals());

describe("useDemo", () => {
  it("reads GET /demo, and takes the source from its answer", async () => {
    mockFetch({ "GET /api/v1/demo": demoStatusFixture({ on: true }) });
    const { W } = setup();
    const { result } = renderHook(() => useDemo(), { wrapper: W });
    await waitFor(() => expect(result.current.data?.on).toBe(true));
    expect(currentSource()).toBe("demo");
  });
});

describe("useDemoOn", () => {
  it("is false while off, true once GET /demo says on", async () => {
    let on = false;
    mockFetch({ "GET /api/v1/demo": () => demoStatusFixture({ on }) });
    const { W, client } = setup();
    const { result } = renderHook(() => useDemoOn(), { wrapper: W });
    await waitFor(() => expect(currentSource()).toBe("real"));
    expect(result.current).toBe(false);
    on = true;
    await act(async () => {
      await client.refetchQueries({ queryKey: ["demo"] });
    });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("is true as soon as the data source is demo, before GET /demo answers", async () => {
    mockFetch({ "GET /api/v1/demo": () => new Promise(() => {}) });
    const { W } = setup();
    const { result } = renderHook(() => useDemoOn(), { wrapper: W });
    expect(result.current).toBe(false);
    act(() => switchSource("demo"));
    expect(result.current).toBe(true);
  });
});

describe("useSetDemo", () => {
  it("PUTs { on }, sets the source, clears every query and toasts the message", async () => {
    const m = mockFetch({
      "PUT /api/v1/demo": () => from("demo", { ...demoStatusFixture({ on: true, refreshedAt: "2026-10-02T11:00:00.000Z" }), message: "Demo mode is on." }),
      "GET /api/v1/demo": () => from("demo", demoStatusFixture({ on: true })),
    });
    switchSource("real");
    const { W, client } = setup();
    seedCache(client);
    function Probe() {
      const s = useSetDemo();
      return <button onClick={() => s.mutate(true)}>on</button>;
    }
    render(
      <W>
        <Probe />
      </W>,
    );
    act(() => screen.getByText("on").click());
    expect(await screen.findByText("Demo mode is on.")).toBeInTheDocument();
    expect(m.callsTo("PUT", "/api/v1/demo")[0]!.body).toEqual({ on: true });
    expect(currentSource()).toBe("demo");
    // Nothing from the real data is left; the switch's own answer is.
    expect(cached(client)).toEqual(['["demo"]']);
    expect(client.getQueryData<{ on: boolean }>(["demo"])?.on).toBe(true);
  });

  it("a refusal (demo_busy on an empty store) leaves the source and the cache alone", async () => {
    mockFetch({ "PUT /api/v1/demo": () => from("real", { error: { code: "demo_busy", message: "Demo data has used today's refresh allowance. Try again at 00:00 tomorrow." } }, 409) });
    switchSource("real");
    const { W, client } = setup();
    seedCache(client);
    const { result } = renderHook(() => useSetDemo(), { wrapper: W });
    const err = await result.current.mutateAsync(true).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/Try again at 00:00 tomorrow/);
    expect(currentSource()).toBe("real");
    expect(cached(client)).toHaveLength(3);
  });
});

describe("useSourceChangeReset (mounted by the shell)", () => {
  it("a real answer arriving after the switch to demo is never rendered or cached", async () => {
    switchSource("real");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    mockFetch({
      "GET /api/v1/things": async () => {
        calls++;
        if (calls === 1) {
          await gate;
          return from("real", { name: "Real thing" });
        }
        return from("demo", { name: "Demo thing" });
      },
    });
    const { W, client } = setup();
    function Probe() {
      useSourceChangeReset();
      const q = useQuery({ queryKey: ["things"], queryFn: () => apiGet<{ name: string }>("/things") });
      return <p>{q.data?.name ?? "loading"}</p>;
    }
    render(
      <W>
        <Probe />
      </W>,
    );
    // Demo mode switched on (useSetDemo's success) while the real read is on its way.
    act(() => switchSource("demo"));
    release();
    await act(async () => {
      await client.resetQueries();
    });
    expect(await screen.findByText("Demo thing")).toBeInTheDocument();
    expect(screen.queryByText("Real thing")).toBeNull();
    expect(client.getQueryData(["things"])).toEqual({ name: "Demo thing" });
  });

  it("an answer from the other source (a switch in another tab) clears the cache and reads again", async () => {
    switchSource("real");
    let source: "real" | "demo" = "real";
    mockFetch({ "GET /api/v1/things": () => from(source, { name: `${source} thing` }) });
    const { W, client } = setup();
    function Probe() {
      useSourceChangeReset();
      const q = useQuery({ queryKey: ["things"], queryFn: () => apiGet<{ name: string }>("/things") });
      return <p>{q.data?.name ?? "loading"}</p>;
    }
    render(
      <W>
        <Probe />
      </W>,
    );
    expect(await screen.findByText("real thing")).toBeInTheDocument();
    client.setQueryData(["clients"], { real: true });
    source = "demo";
    await act(async () => {
      await client.refetchQueries({ queryKey: ["things"] }).catch(() => {});
    });
    expect(await screen.findByText("demo thing")).toBeInTheDocument();
    expect(client.getQueryData(["clients"])).toBeUndefined();
    expect(currentSource()).toBe("demo");
  });
});

describe("useRefreshDemo", () => {
  it("POSTs /demo/refresh, keeps the new status, toasts and invalidates everything", async () => {
    const m = mockFetch({ "POST /api/v1/demo/refresh": { ...demoStatusFixture({ refreshedAt: "2026-10-02T12:00:00.000Z" }), message: "Demo data refreshed." } });
    const { W, client } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    function Probe() {
      const r = useRefreshDemo();
      return <button onClick={() => r.mutate()}>refresh</button>;
    }
    render(
      <W>
        <Probe />
      </W>,
    );
    act(() => screen.getByText("refresh").click());
    expect(await screen.findByText("Demo data refreshed.")).toBeInTheDocument();
    expect(m.callsTo("POST", "/api/v1/demo/refresh")).toHaveLength(1);
    expect(client.getQueryData<{ refreshedAt: string }>(["demo"])?.refreshedAt).toBe("2026-10-02T12:00:00.000Z");
    expect(invalidate).toHaveBeenCalledWith();
  });

  it("is still sent while the data source is demo (a control route)", async () => {
    switchSource("demo");
    const m = mockFetch({ "POST /api/v1/demo/refresh": { ...demoStatusFixture({ on: true }), message: "Demo data refreshed." } });
    const { W } = setup();
    const { result } = renderHook(() => useRefreshDemo(), { wrapper: W });
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(m.spy).toHaveBeenCalledTimes(1);
  });
});

describe("useDevSeed", () => {
  it("POSTs /__dev/seed?scenario=, toasts the counts and invalidates everything", async () => {
    const m = mockFetch({ "POST /__dev/seed": { ok: true, scenario: "running", now: "2026-10-02T12:00:00.000Z", counts: { peers: 8, runs: 14 } } });
    const { W, client } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    function Probe() {
      const s = useDevSeed();
      return <button onClick={() => s.mutate("running")}>seed</button>;
    }
    render(
      <W>
        <Probe />
      </W>,
    );
    act(() => screen.getByText("seed").click());
    expect(await screen.findByText("Seeded running: peers 8, runs 14")).toBeInTheDocument();
    expect(m.calls[0]!.url).toBe("/__dev/seed?scenario=running");
    expect(m.calls[0]!.init.method).toBe("POST");
    expect(invalidate).toHaveBeenCalledWith();
  });

  it("a 404 says the seeder only exists on the local dev server", async () => {
    mockFetch({ "POST /__dev/seed": { status: 404, text: "404 Not Found", contentType: "text/plain" } });
    const { W } = setup();
    const { result } = renderHook(() => useDevSeed(), { wrapper: W });
    const err = await result.current.mutateAsync("empty").catch((e: Error) => e);
    expect((err as Error).message).toBe(DEV_SEED_404);
    expect(DEV_SEED_404).toBe("The seeder only exists on the local dev server.");
  });

  it("is sent while the data source is demo (the dev seeder is not an /api/v1 write)", async () => {
    switchSource("demo");
    const m = mockFetch({ "POST /__dev/seed": { ok: true, scenario: "empty", now: "2026-10-02T12:00:00.000Z", counts: { peers: 0 } } });
    const { W } = setup();
    const { result } = renderHook(() => useDevSeed(), { wrapper: W });
    const res = await result.current.mutateAsync("empty").catch((e: Error) => e);
    expect(res).not.toHaveProperty("message", DEMO_REFUSED_MESSAGE);
    expect(m.spy).toHaveBeenCalledTimes(1);
  });
});
