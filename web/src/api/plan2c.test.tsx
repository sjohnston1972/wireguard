import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { SimResult } from "@shared/api";
import { makeQueryClient } from "./queryClient";
import { connection, resetConnection } from "./connection";
import { useRuleHistory, INTERVALS } from "./queries";
import { useHealthCheck, useSimulate } from "./mutations";
import { downloadFile, downloadExport, downloadConfigBackup } from "./download";
import { ApiError, NetworkError, SessionExpiredError } from "./client";
import { ToastProvider } from "@/components/feedback/Toast";
import { mockFetch } from "@/test/mockFetch";
import { firewallFixture } from "@/test/fixtures";

function setup() {
  const client = makeQueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const W = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
  return { W, client, invalidate };
}

beforeEach(() => resetConnection());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useRuleHistory", () => {
  it("asks for one firewall counter's history by key and range, refreshing every 60 s", async () => {
    const m = mockFetch({ "GET /api/v1/history": { range: "24h", step: 3600, from: "a", to: "b", points: [], latest: null } });
    const { W, client } = setup();
    const { result } = renderHook(() => useRuleHistory("r7", "24h"), { wrapper: W });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(m.calls[0]!.url).toBe("/api/v1/history?scope=rule&id=r7&range=24h");
    const q = client.getQueryCache().getAll()[0]!;
    expect(q.queryKey[0]).toBe("history");
    expect(q.observers[0]!.options.refetchInterval).toBe(INTERVALS.history);
  });

  it("takes the default action's key too", async () => {
    const m = mockFetch({ "GET /api/v1/history": { points: [] } });
    const { W } = setup();
    renderHook(() => useRuleHistory("default", "7d"), { wrapper: W });
    await waitFor(() => expect(m.calls.length).toBe(1));
    expect(m.calls[0]!.url).toBe("/api/v1/history?scope=rule&id=default&range=7d");
  });
});

describe("useSimulate", () => {
  const result: SimResult = { verdict: "allow", matched: { id: 3, name: "Clients to home LAN", place: 3 }, reason: "Rule 3 allows it.", partial: [], limited: null };

  it("posts the flow and hands the result to the caller, with no success toast and nothing refreshed", async () => {
    const m = mockFetch({ "POST /api/v1/firewall/simulate": result });
    const { W, invalidate } = setup();
    const { result: hook } = renderHook(() => useSimulate(), { wrapper: W });
    let out: SimResult | undefined;
    await act(async () => {
      out = await hook.current.mutateAsync({ from: { kind: "zone", value: "clients" }, to: { kind: "zone", value: "home" }, proto: "tcp", port: 22 });
    });
    expect(out).toEqual(result);
    expect(m.calls[0]).toMatchObject({ method: "POST", url: "/api/v1/firewall/simulate", body: { proto: "tcp", port: 22 } });
    expect(screen.queryByText(/Rule 3 allows it/)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("useHealthCheck", () => {
  it("posts, shows the server's message as a toast (like the speed test) and refreshes the overview", async () => {
    const m = mockFetch({ "POST /api/v1/health-check": { ok: true, message: "Health check requested. The VM runs it within a minute." } });
    const { W, invalidate } = setup();
    function Probe() {
      const h = useHealthCheck();
      return <button onClick={() => h.mutate()}>go</button>;
    }
    render(
      <W>
        <Probe />
      </W>,
    );
    act(() => screen.getByText("go").click());
    expect(await screen.findByText("Health check requested. The VM runs it within a minute.")).toBeInTheDocument();
    expect(m.calls[0]).toMatchObject({ method: "POST", url: "/api/v1/health-check" });
    expect(m.calls[0]!.init.body).toBeUndefined();
    const keys = invalidate.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    expect(keys).toContain('["overview"]');
  });
});

describe("firewall fixture", () => {
  it("carries hourly trends with nulls for hours the VM was down", () => {
    const fw = firewallFixture();
    expect(fw.rules[0]!.trend24h).toHaveLength(24);
    expect(fw.rules[0]!.trend24h).toContain(null);
    expect(fw.defaultTrend24h).toHaveLength(24);
    expect(fw.drops.hourly24h).toHaveLength(24);
    expect(fw.drops.hourly24h).toContain(null);
  });
});

describe("downloadFile", () => {
  function captureAnchor() {
    const clicked: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download });
    });
    const create = vi.fn(() => "blob:wg-admin/1");
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    return { clicked, create, revoke };
  }

  it("fetches the file itself (not through apiGet) and saves it under the server's file name", async () => {
    const m = mockFetch({
      "GET /api/v1/backup/export": () =>
        new Response('{"tables":{}}', { status: 200, headers: { "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="wg-admin-export-2026-10-02.json"' } }),
    });
    const { clicked, create, revoke } = captureAnchor();
    await downloadExport();
    expect(m.calls[0]!.url).toBe("/api/v1/backup/export");
    expect(m.calls[0]!.init.redirect).toBe("manual");
    expect(m.calls[0]!.init.credentials).toBe("same-origin");
    expect(create).toHaveBeenCalledTimes(1);
    expect(clicked).toEqual([{ href: "blob:wg-admin/1", download: "wg-admin-export-2026-10-02.json" }]);
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:wg-admin/1"));
    expect(document.querySelector("a[download]")).toBeNull();
  });

  it("downloads a nightly config backup by day, with a fallback name", async () => {
    const m = mockFetch({ "GET /api/v1/backup/config/2026-09-30": () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }) });
    const { clicked } = captureAnchor();
    await downloadConfigBackup("2026-09-30");
    expect(m.calls[0]!.url).toBe("/api/v1/backup/config/2026-09-30");
    expect(clicked[0]!.download).toBe("wg-admin-config-2026-09-30.json");
  });

  it("treats a redirect as an expired session and saves nothing", async () => {
    mockFetch({ "GET /api/v1/backup/export": { opaqueRedirect: true } });
    const { clicked } = captureAnchor();
    await expect(downloadFile("/backup/export", "x.json")).rejects.toBeInstanceOf(SessionExpiredError);
    expect(connection.get().sessionExpired).toBe(true);
    expect(clicked).toEqual([]);
  });

  it("maps a refusal to ApiError and a lost link to NetworkError", async () => {
    mockFetch({
      "GET /api/v1/backup/config/2020-01-01": { status: 404, json: { error: { code: "not_found", message: "That nightly export is no longer kept." } } },
      "GET /api/v1/backup/export": { networkError: true },
    });
    captureAnchor();
    const err = await downloadConfigBackup("2020-01-01").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, message: "That nightly export is no longer kept." });
    await expect(downloadExport()).rejects.toBeInstanceOf(NetworkError);
  });
});
