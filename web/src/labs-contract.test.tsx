// labs-contract.test.tsx
//
// Plain English: the app side of the lab contract (plan L0.4): the Labs tab
// and its lazy routes, the lab hooks (what each one asks for, how often, and
// what it refreshes), the fixtures, and the rule that the first page load
// never pulls in the Labs tab's code.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, screen, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderApp } from "@/test/render";
import { setViewport } from "@/test/viewport";
import { mockFetch } from "@/test/mockFetch";
import { labCoverageFixture, labDetailFixture, labSessionFixture, labsFixture, overviewFixture } from "@/test/fixtures";
import { makeQueryClient } from "@/api/queryClient";
import { resetConnection } from "@/api/connection";
import { ToastProvider } from "@/components/feedback/Toast";
import { INTERVALS, labDetailInterval, labsInterval } from "@/api/queries";
import {
  useCancelLab,
  useCheckLabPermissions,
  useCleanupLabOrphans,
  useDeployLab,
  useDestroyLab,
  useExtendLab,
  useLabSecret,
  usePeerLab,
  useRePeerLabs,
  useSaveLabNote,
  useTestLab,
  useUnpeerLab,
} from "@/api/mutations";
import { TABS } from "@/routes";

const SRC = dirname(fileURLToPath(import.meta.url));

beforeEach(() => resetConnection());
afterEach(() => vi.unstubAllGlobals());

describe("the Labs tab", () => {
  it("Labs tab sits after Cost and before Settings", () => {
    expect(TABS.map((t) => t.label)).toEqual(["Overview", "Clients", "Firewall", "Activity", "Cost", "Labs", "Settings"]);
    expect(TABS.find((t) => t.label === "Labs")!.to).toBe("/labs");
    renderApp("/");
    const links = within(screen.getByRole("navigation", { name: "Main" })).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Overview", "Clients", "Firewall", "Activity", "Cost", "Labs", "Settings"]);
  });

  it.each(["/labs", "/labs/az104-06-blob-security", "/labs/history"])("%s loads the lazy page", { timeout: 20_000 }, async (url) => {
    renderApp(url);
    expect(await within(screen.getByRole("main")).findByRole("heading", { level: 1, name: "Labs" })).toBeInTheDocument();
    const marked = within(screen.getByRole("navigation", { name: "Main" })).getAllByRole("link", { current: "page" });
    expect(marked.map((l) => l.textContent)).toEqual(["Labs"]);
  });

  it("the phone bar shows seven icons without overflow at 390 px", () => {
    setViewport("phone");
    renderApp("/labs");
    const bar = screen.getByRole("navigation", { name: "Phone" });
    const links = within(bar).getAllByRole("link");
    expect(links).toHaveLength(7);
    for (const l of links) expect(l.querySelector("svg")).not.toBeNull();
    // Each tab gets an equal share that can shrink below its label (min-width: 0), and a label too long for it is cut with an ellipsis, never pushing the bar wider.
    const css = readFileSync(join(SRC, "shell", "AppShell.css"), "utf8");
    const rule = (sel: string) => css.match(new RegExp(`\\${sel}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
    expect(rule(".tabbar__tab")).toMatch(/flex:\s*1/);
    expect(rule(".tabbar__tab")).toMatch(/min-width:\s*0/);
    expect(rule(".tabbar__label")).toMatch(/overflow:\s*hidden/);
    expect(rule(".tabbar__label")).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule(".tabbar__label")).toMatch(/white-space:\s*nowrap/);
    for (const l of links) expect(l.querySelector(".tabbar__label")?.textContent).toBe(l.textContent);
    // 390 px across seven tabs leaves each at least a 44 px touch target.
    expect(390 / links.length).toBeGreaterThanOrEqual(44);
  });

  it("Settings lists a Labs section with its own body", async () => {
    renderApp("/settings/labs");
    expect(await screen.findByRole("tab", { name: /Labs/ })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Release tests" })).toBeInTheDocument();
  });
});

describe("the entry graph", () => {
  /** Every file the entry (main.tsx) reaches by static imports; dynamic import() is where lazy chunks start. */
  function staticGraph(entry: string): Set<string> {
    const seen = new Set<string>();
    const resolveFrom = (from: string, spec: string): string | null => {
      let base: string;
      if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
      else if (spec.startsWith("@shared/")) base = join(SRC, "..", "..", "shared", spec.slice(8));
      else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
      else return null; // a package
      for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) if (existsSync(c) && /\.(tsx?|json)$/.test(c)) return c;
      return null;
    };
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      if (file.endsWith(".json")) return;
      const src = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
      for (const m of src.matchAll(/(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\sfrom\s+)?["']([^"']+)["']/g)) {
        if (/^(?:import|export)\s+type\s/.test(m[0].replace(/^[\s;]+/, ""))) continue; // types only: nothing in the bundle
        const next = resolveFrom(file, m[1]);
        if (next) walk(next);
      }
    };
    walk(entry);
    return seen;
  }

  it("the entry graph never imports views/labs", () => {
    const graph = [...staticGraph(join(SRC, "main.tsx"))].map((f) => f.split("\\").join("/"));
    expect(graph.some((f) => f.endsWith("/views/pages.tsx"))).toBe(true);
    expect(graph.filter((f) => f.includes("/views/labs/"))).toEqual([]);
    // Nor the Worker's catalogue: the app reads GET /labs (plan ruling 1).
    expect(graph.filter((f) => f.includes("labs.generated"))).toEqual([]);
  });
});

describe("lab hooks", () => {
  it("useLabs polls 5 s while a session deploys, else 15 s", () => {
    expect(INTERVALS.labs).toBe(15_000);
    expect(labsInterval(undefined)).toBe(15_000);
    expect(labsInterval(labsFixture())).toBe(15_000);
    const running = labSessionFixture({ state: "running" });
    expect(labsInterval(labsFixture({ running: [running] }))).toBe(15_000);
    expect(labsInterval(labsFixture({ running: [running, labSessionFixture({ id: "ls-2", state: "deploying" })] }))).toBe(5_000);
    expect(labsInterval(labsFixture({ running: [labSessionFixture({ state: "tearing_down" })] }))).toBe(5_000);
    // A peer or unpeer run on a running lab is busy too.
    expect(labsInterval(labsFixture({ running: [labSessionFixture({ state: "running", activeRun: labDetailFixture().runs[0] })] }))).toBe(5_000);
    expect(labDetailInterval(labDetailFixture())).toBe(15_000);
    expect(labDetailInterval(labDetailFixture({ session: labSessionFixture({ state: "deploying" }) }))).toBe(5_000);
    expect(labDetailInterval(labDetailFixture({ session: null, runs: [] }))).toBe(15_000);
    expect(labDetailInterval(undefined)).toBe(15_000);
  });

  function setup() {
    const client = makeQueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const W = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    );
    return { W, invalidate };
  }
  const keys = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
  const ok = { ok: true, message: "Done." };
  const id = "az104-06-blob-security";

  const CASES: [string, () => { mutateAsync: (v: never) => Promise<unknown> }, unknown, string, string, unknown][] = [
    ["useDeployLab", useDeployLab, { id, hours: 2, peer: true }, "POST", `/api/v1/labs/${id}/deploy`, { hours: 2, peer: true }],
    ["useExtendLab", useExtendLab, { id, hours: 1 }, "POST", `/api/v1/labs/${id}/extend`, { hours: 1 }],
    ["useExtendLab to max", useExtendLab, { id, toMax: true }, "POST", `/api/v1/labs/${id}/extend`, { toMax: true }],
    ["useDestroyLab", useDestroyLab, id, "POST", `/api/v1/labs/${id}/destroy`, { confirm: true }],
    ["usePeerLab", usePeerLab, id, "POST", `/api/v1/labs/${id}/peer`, undefined],
    ["useUnpeerLab", useUnpeerLab, id, "POST", `/api/v1/labs/${id}/unpeer`, undefined],
    ["useTestLab", useTestLab, id, "POST", `/api/v1/labs/${id}/test`, undefined],
    ["useCancelLab", useCancelLab, id, "POST", `/api/v1/labs/${id}/cancel`, undefined],
    ["useRePeerLabs", useRePeerLabs, undefined, "POST", "/api/v1/labs/repeer", undefined],
    ["useSaveLabNote", useSaveLabNote, { sid: "ls-1", note: "hi" }, "PUT", "/api/v1/labs/sessions/ls-1/note", { note: "hi" }],
    ["useCleanupLabOrphans", useCleanupLabOrphans, { lab_id: id }, "POST", "/api/v1/labs/orphans/cleanup", { lab_id: id }],
    ["useCheckLabPermissions", useCheckLabPermissions, undefined, "POST", "/api/v1/labs/permissions/check", undefined],
  ];

  it.each(CASES)("each lab mutation posts its route and invalidates labs and overview: %s", async (_name, hook, vars, method, path, body) => {
    const reply = path.endsWith("/permissions/check") ? { ...ok, permissions: labsFixture().permissions } : ok;
    const { calls } = mockFetch({ [`${method} ${path}`]: reply });
    const { W, invalidate } = setup();
    const { result } = renderHook(() => hook(), { wrapper: W });
    await act(async () => {
      await result.current.mutateAsync(vars as never);
    });
    const call = calls.find((c) => c.url === path)!;
    expect(call.method).toBe(method);
    expect(call.body).toEqual(body);
    expect(keys(invalidate)).toEqual(expect.arrayContaining(['["labs"]', '["overview"]']));
  });

  // Labs redesign spec §13.4: a refusal means the cards' blockers and warnings are out of date.
  it('a refused deploy invalidates ["labs"]', async () => {
    for (const [status, code] of [
      [409, "unavailable"],
      [422, "confirm_required"],
    ] as const) {
      mockFetch({ [`POST /api/v1/labs/${id}/deploy`]: { status, json: { error: { code, message: "Needs the labs governance role." } } } });
      const { W, invalidate } = setup();
      const { result } = renderHook(() => useDeployLab(), { wrapper: W });
      await act(async () => {
        await result.current.mutateAsync({ id, hours: 2, peer: false }).catch(() => undefined);
      });
      expect(keys(invalidate), code).toEqual(['["labs"]']);
    }
  });

  it("useLabSecret fetches the secret when asked, and keeps nothing", async () => {
    const { calls } = mockFetch({ [`GET /api/v1/labs/${id}/secret`]: { adminPassword: "pw-from-test", users: { ann: "lab-x-ann@contoso.onmicrosoft.com" } } });
    const { W, invalidate } = setup();
    const { result } = renderHook(() => useLabSecret(), { wrapper: W });
    let got: unknown;
    await act(async () => {
      got = await result.current.mutateAsync(id);
    });
    expect(got).toEqual({ adminPassword: "pw-from-test", users: { ann: "lab-x-ann@contoso.onmicrosoft.com" } });
    expect(calls.filter((c) => c.url === `/api/v1/labs/${id}/secret`)).toHaveLength(1);
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("fixtures", () => {
  it("mockFetch answers /api/v1/labs* with an empty catalogue, and overviewFixture has empty labs", async () => {
    mockFetch({});
    expect(await (await fetch("/api/v1/labs")).json()).toEqual(labsFixture());
    expect(labsFixture()).toMatchObject({ labs: [], running: [], orphans: [], slots: { used: 0, total: 32 }, maxRunning: 3 });
    expect(await (await fetch("/api/v1/labs/sessions?limit=50")).json()).toEqual({ sessions: [] });
    expect(await (await fetch("/api/v1/labs/coverage")).json()).toEqual({ exams: [] });
    const detail = await fetch("/api/v1/labs/az104-06-blob-security");
    expect(detail.status).toBe(404);
    expect(((await detail.json()) as { error: { code: string } }).error.code).toBe("not_found");
    expect(overviewFixture().labs).toEqual({ running: [], gbpH: 0, rePeer: 0 });
  });

  it("the lab fixtures are whole answers", () => {
    const d = labDetailFixture();
    expect(d.card.id).toBe("az104-06-blob-security");
    expect(d.session?.state).toBe("running");
    expect(d.readme.length).toBeGreaterThan(0);
    expect(labCoverageFixture().exams[0].exam).toBe("AZ-104");
    expect(labSessionFixture().labId).toBe("az104-06-blob-security");
  });
});
