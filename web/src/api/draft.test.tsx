import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { SimResult } from "@shared/api";
import { makeQueryClient } from "./queryClient";
import { resetConnection } from "./connection";
import {
  useDraftAddRule,
  useDraftApply,
  useDraftDefault,
  useDraftDeleteRule,
  useDraftDiscard,
  useDraftEditRule,
  useDraftFromDrop,
  useDraftMoveRule,
  useSimulate,
} from "./mutations";
import { ApiError } from "./client";
import { ToastProvider } from "@/components/feedback/Toast";
import { mockFetch } from "@/test/mockFetch";

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
const keys = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
const OK = { ok: true, message: "Saved to the draft." };

beforeEach(() => resetConnection());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("firewall draft mutations", () => {
  const rule = { name: "Web to workloads", from: { kind: "zone", value: "clients" }, to: { kind: "cidr", value: "198.51.100.0/24" }, proto: "tcp", ports: "443", action: "allow" } as const;

  it.each([
    ["add", () => useDraftAddRule(), rule, "POST", "/api/v1/firewall/draft/rules", rule],
    ["edit sends only the given fields", () => useDraftEditRule(), { id: 7, enabled: false }, "PUT", "/api/v1/firewall/draft/rules/7", { enabled: false }],
    ["move by one step", () => useDraftMoveRule(), { id: 7, dir: "up" }, "POST", "/api/v1/firewall/draft/rules/7/move", { dir: "up" }],
    ["move to an index", () => useDraftMoveRule(), { id: 7, to: 0 }, "POST", "/api/v1/firewall/draft/rules/7/move", { to: 0 }],
    ["delete", () => useDraftDeleteRule(), 7, "DELETE", "/api/v1/firewall/draft/rules/7", undefined],
    ["default", () => useDraftDefault(), { action: "allow" }, "PUT", "/api/v1/firewall/draft/default", { action: "allow" }],
    ["from a drop", () => useDraftFromDrop(), { src: "203.0.113.9", dst: "10.13.13.2", proto: "tcp", dport: 22 }, "POST", "/api/v1/firewall/draft/from-drop", { src: "203.0.113.9", dst: "10.13.13.2", proto: "tcp", dport: 22 }],
    ["apply", () => useDraftApply(), { baseVersion: 4 }, "POST", "/api/v1/firewall/draft/apply", { baseVersion: 4 }],
    ["discard", () => useDraftDiscard(), undefined, "DELETE", "/api/v1/firewall/draft", undefined],
  ] as const)("%s: sends the right request and refreshes the firewall", async (_name, hook, vars, method, url, body) => {
    const m = mockFetch({ [`${method} ${url}`]: OK });
    const { W, invalidate } = setup();
    const { result } = renderHook(hook as () => { mutateAsync: (v: unknown) => Promise<unknown> }, { wrapper: W });
    await act(async () => {
      await result.current.mutateAsync(vars);
    });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]).toMatchObject({ method, url });
    expect(m.calls[0]!.body).toEqual(body);
    expect(keys(invalidate)).toContain('["firewall"]');
  });

  it("edits to the draft show no success toast (the draft bar counts them); apply and from-drop do", async () => {
    mockFetch({
      "PUT /api/v1/firewall/draft/rules/7": { ok: true, message: "Rule saved to the draft." },
      "POST /api/v1/firewall/draft/apply": { ok: true, message: "Applied 2 changes. The VM picks them up within 30 seconds." },
      "POST /api/v1/firewall/draft/from-drop": { ok: true, message: "Added an allow rule to the draft." },
    });
    const { W } = setup();
    function Probe() {
      const edit = useDraftEditRule();
      const apply = useDraftApply();
      const drop = useDraftFromDrop();
      return (
        <>
          <button onClick={() => edit.mutate({ id: 7, enabled: false })}>edit</button>
          <button onClick={() => apply.mutate({ baseVersion: 3 })}>apply</button>
          <button onClick={() => drop.mutate({ src: "203.0.113.9", dst: "10.13.13.2", proto: "icmp", dport: null })}>drop</button>
        </>
      );
    }
    render(
      <W>
        <Probe />
      </W>,
    );
    await act(async () => screen.getByText("edit").click());
    await act(async () => screen.getByText("apply").click());
    expect(await screen.findByText("Applied 2 changes. The VM picks them up within 30 seconds.")).toBeInTheDocument();
    await act(async () => screen.getByText("drop").click());
    expect(await screen.findByText("Added an allow rule to the draft.")).toBeInTheDocument();
    expect(screen.queryByText("Rule saved to the draft.")).toBeNull();
  });

  it("a stale apply is a 409 ApiError with the server's message, and an edit's bad field is readable with fieldError", async () => {
    mockFetch({
      "POST /api/v1/firewall/draft/apply": { status: 409, json: { error: { code: "conflict", message: "The live rules changed since this draft began. Discard it and start again." } } },
      "POST /api/v1/firewall/draft/rules/7/move": { status: 400, json: { error: { code: "bad_input", message: "Choose a place from 0 to 5.", field: "to" } } },
    });
    const { W } = setup();
    const apply = renderHook(() => useDraftApply(), { wrapper: W });
    let err: unknown;
    await act(async () => {
      await apply.result.current.mutateAsync({ baseVersion: 1 }).catch((e) => (err = e));
    });
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).message).toMatch(/changed since this draft began/);

    const move = renderHook(() => useDraftMoveRule(), { wrapper: W });
    await act(async () => {
      await move.result.current.mutateAsync({ id: 7, to: 9 }).catch(() => {});
    });
    expect(move.result.current.fieldError("to")).toBe("Choose a place from 0 to 5.");
  });
});

describe("useSimulate policy", () => {
  it("sends policy draft when asked", async () => {
    const result: SimResult = { verdict: "deny", matched: null, reason: "No rule matched; the default denies it.", partial: [], limited: null };
    const m = mockFetch({ "POST /api/v1/firewall/simulate": result });
    const { W } = setup();
    const { result: hook } = renderHook(() => useSimulate(), { wrapper: W });
    await act(async () => {
      await hook.current.mutateAsync({ from: { kind: "zone", value: "clients" }, to: { kind: "zone", value: "home" }, proto: "tcp", port: 22, policy: "draft" });
    });
    expect(m.calls[0]!.body).toMatchObject({ policy: "draft", proto: "tcp", port: 22 });
  });
});
