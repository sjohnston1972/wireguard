// Demo mode, the app's side of the contract (spec 2026-10-08-demo-mode-design.md §8.2):
// every /api/v1 answer says where it came from (X-WG-Data: real|demo); an answer
// from the other source is never returned (so never cached or shown), the source
// switch is announced, and while the source is demo no write leaves the browser.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { DEMO_REFUSED_MESSAGE, demoRouteKind } from "@shared/demo";
import { ApiError, SourceChangedError, apiGet, apiSend, currentSource, onSourceChange, resetSource, switchSource } from "./client";
import { resetConnection } from "./connection";
import { makeQueryClient, shouldRetry } from "./queryClient";
import * as mutations from "./mutations";
import { ToastProvider } from "@/components/feedback/Toast";
import { mockFetch } from "@/test/mockFetch";

/** A JSON answer stamped with its source, as the Worker's gate sends it. */
const from = (source: "real" | "demo", json: unknown, status = 200) =>
  new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json", "X-WG-Data": source } });

beforeEach(() => {
  resetConnection();
  resetSource();
});
afterEach(() => vi.unstubAllGlobals());

describe("data source tracking", () => {
  it("is unknown until the first answer, then takes that answer's source without announcing a change", async () => {
    const changed = vi.fn();
    const off = onSourceChange(changed);
    mockFetch({ "GET /api/v1/clients": () => from("real", { clients: [] }) });
    expect(currentSource()).toBeNull();
    expect(await apiGet("/clients")).toEqual({ clients: [] });
    expect(currentSource()).toBe("real");
    expect(changed).not.toHaveBeenCalled();
    off();
  });

  it("an answer from the other source throws SourceChangedError, announces the change and updates the source", async () => {
    const changed = vi.fn();
    const off = onSourceChange(changed);
    let source: "real" | "demo" = "real";
    mockFetch({ "GET /api/v1/clients": () => from(source, { clients: [{ name: source }] }) });
    await apiGet("/clients");
    source = "demo";
    await expect(apiGet("/clients")).rejects.toBeInstanceOf(SourceChangedError);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith("demo");
    expect(currentSource()).toBe("demo");
    // The next answer from the new source passes.
    expect(await apiGet("/clients")).toEqual({ clients: [{ name: "demo" }] });
    expect(changed).toHaveBeenCalledTimes(1);
    off();
  });

  it("an answer without the header changes nothing", async () => {
    switchSource("real");
    mockFetch({ "GET /api/v1/clients": { clients: [] } });
    expect(await apiGet("/clients")).toEqual({ clients: [] });
    expect(currentSource()).toBe("real");
  });

  it("an answer sent before a switch is dropped, and cannot switch the source back", async () => {
    const changed = vi.fn();
    const off = onSourceChange(changed);
    switchSource("real");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mockFetch({
      "GET /api/v1/overview": async () => {
        await gate;
        return from("real", { stale: true });
      },
    });
    const late = apiGet("/overview");
    // Demo mode is switched on while that read is in flight.
    switchSource("demo");
    release();
    await expect(late).rejects.toBeInstanceOf(SourceChangedError);
    expect(currentSource()).toBe("demo");
    expect(changed).not.toHaveBeenCalled();
    off();
  });

  it("a refusal from the other source still says why (the error is not data)", async () => {
    switchSource("real");
    mockFetch({ "POST /api/v1/notes/ack": () => from("demo", { error: { code: "demo_mode", message: DEMO_REFUSED_MESSAGE } }, 409) });
    const err = (await apiSend("POST", "/notes/ack").catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("demo_mode");
    expect(currentSource()).toBe("demo");
  });

  it("503 demo_unknown carries no header (the Worker will not guess): no flip, no clear, the message shown", async () => {
    const changed = vi.fn();
    const off = onSourceChange(changed);
    for (const start of ["demo", "real"] as const) {
      switchSource(start);
      mockFetch({ "GET /api/v1/overview": { status: 503, json: { error: { code: "demo_unknown", message: "Could not check demo mode. Try again." } } } });
      const err = (await apiGet("/overview").catch((e) => e)) as ApiError;
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 503, code: "demo_unknown", message: "Could not check demo mode. Try again." });
      expect(currentSource()).toBe(start);
    }
    expect(changed).not.toHaveBeenCalled();
    off();
  });

  it("GET /demo states the mode after a switch elsewhere: its answer is kept, and the change announced", async () => {
    const changed = vi.fn();
    const off = onSourceChange(changed);
    switchSource("real");
    mockFetch({ "GET /api/v1/demo": () => from("demo", { on: true }) });
    expect(await apiGet("/demo")).toEqual({ on: true });
    expect(currentSource()).toBe("demo");
    expect(changed).toHaveBeenCalledWith("demo");
    off();
  });

  it("shouldRetry retries SourceChangedError, like a network blip", () => {
    expect(shouldRetry(0, new SourceChangedError())).toBe(true);
    expect(shouldRetry(1, new SourceChangedError())).toBe(true);
  });
});

describe("the client guard", () => {
  it("while the source is demo, a write is refused with demo_mode and never sent", async () => {
    switchSource("demo");
    const m = mockFetch({ "POST /api/v1/deploy": { ok: true, message: "sent" } });
    const err = (await apiSend("POST", "/deploy", { hours: 4 }).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: "demo_mode", message: DEMO_REFUSED_MESSAGE });
    expect(m.spy).not.toHaveBeenCalled();
  });

  it("while demo, the control routes and the simulator are still sent", async () => {
    switchSource("demo");
    const m = mockFetch({
      "PUT /api/v1/demo": () => from("real", { on: false, message: "Demo mode is off." }),
      "POST /api/v1/demo/refresh": () => from("demo", { on: true, message: "Demo data refreshed." }),
      "POST /api/v1/firewall/simulate": () => from("demo", { verdict: "allow" }),
    });
    await apiSend("POST", "/demo/refresh");
    await apiSend("POST", "/firewall/simulate", { proto: "tcp" });
    await apiSend("PUT", "/demo", { on: false });
    expect(m.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST /api/v1/demo/refresh", "POST /api/v1/firewall/simulate", "PUT /api/v1/demo"]);
  });

  it("while real, writes are sent as before", async () => {
    switchSource("real");
    const m = mockFetch({ "POST /api/v1/deploy": { ok: true, message: "sent" } });
    await apiSend("POST", "/deploy", {});
    expect(m.spy).toHaveBeenCalledTimes(1);
  });
});

// Every write hook in mutations.ts, called while the source is demo: refused
// with demo_mode before fetch, except the one POST that writes nothing.
describe("every mutation hook while demo", () => {
  const hooks = Object.entries(mutations).filter(([name, v]) => /^use[A-Z]/.test(name) && name !== "useApiMutation" && typeof v === "function") as [string, () => { mutateAsync: (v: unknown) => Promise<unknown> }][];
  // Reads that happen to be mutations (no toast, nothing kept): a GET is a read in demo too.
  const reads = new Set(["useSimulate", "useLabSecret"]);

  function W({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={makeQueryClient()}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    );
  }

  it("covers the hooks (a table that silently shrank would prove nothing)", () => {
    expect(hooks.length).toBeGreaterThan(50);
  });

  for (const [name, hook] of hooks) {
    if (reads.has(name)) continue;
    it(`${name} rejects with demo_mode and never calls fetch`, async () => {
      switchSource("demo");
      const m = mockFetch({});
      const { result } = renderHook(() => hook(), { wrapper: W });
      const err = (await result.current.mutateAsync({ id: 1, sid: "s1", hours: 4, confirm: "destroy", public_key: "k", endpoint: "e", token: "t" }).catch((e: unknown) => e)) as ApiError;
      expect(err).toBeInstanceOf(ApiError);
      expect(err.code).toBe("demo_mode");
      expect(m.spy).not.toHaveBeenCalled();
    });
  }

  it("useSimulate is still sent (it writes nothing)", async () => {
    expect(demoRouteKind("POST", "/firewall/simulate")).toBe("read");
    switchSource("demo");
    const m = mockFetch({ "POST /api/v1/firewall/simulate": () => from("demo", { verdict: "allow" }) });
    const { result } = renderHook(() => mutations.useSimulate(), { wrapper: W });
    await act(async () => {
      await result.current.mutateAsync({} as never);
    });
    expect(m.spy).toHaveBeenCalledTimes(1);
  });

  it("the refusal toasts: Demo mode is on: actions are off.", async () => {
    switchSource("demo");
    mockFetch({});
    function Probe() {
      const m = mutations.useAckNotes();
      return <button onClick={() => m.mutate(undefined)}>go</button>;
    }
    render(
      <W>
        <Probe />
      </W>,
    );
    act(() => screen.getByText("go").click());
    expect(await screen.findByText(DEMO_REFUSED_MESSAGE)).toBeInTheDocument();
  });
});
