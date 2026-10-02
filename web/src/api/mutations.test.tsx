import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { makeQueryClient } from "./queryClient";
import { resetConnection } from "./connection";
import { fieldErrorOf, useAddClient, useDeleteClient, useDeploy, useDestroy, useForwardAdd, useAckNotes } from "./mutations";
import { ToastProvider } from "@/shell/toast";
import { mockFetch } from "@/test/mockFetch";
import { ApiError } from "./client";

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
const keys = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) =>JSON.stringify((c[0] as { queryKey: unknown }).queryKey));

beforeEach(() => resetConnection());
afterEach(() => vi.unstubAllGlobals());

describe("mutations", () => {
  it("shows the server's message as a success toast and invalidates the affected queries", async () => {
    mockFetch({ "POST /api/v1/deploy": { ok: true, message: "Deploy started in UK South (r1). About 4 minutes." } });
    const { W, invalidate } = setup();
    const { result } = renderHook(() => useDeploy(), { wrapper: W });
    await act(async () => {
      await result.current.mutateAsync({ hours: 4 });
    });
    expect(keys(invalidate)).toEqual(expect.arrayContaining(['["overview"]', '["activity"]', '["session"]']));
  });

  it("renders a success toast", async () => {
    mockFetch({ "POST /api/v1/cancel": { ok: true, message: "Cancel requested." } });
    const { W } = setup();
    function Probe() {
      const m = useAckNotes();
      return <button onClick={() => m.mutate(undefined)}>go</button>;
    }
    mockFetch({ "POST /api/v1/notes/ack": { ok: true, message: "Notes marked as read." } });
    render(
      <W>
        <Probe />
      </W>,
    );
    act(() => screen.getByText("go").click());
    expect(await screen.findByText("Notes marked as read.")).toBeInTheDocument();
  });

  it("shows a warning as a warning toast, alongside the message", async () => {
    mockFetch({ "POST /api/v1/firewall/forwards": { ok: true, message: "Published TCP 8080.", warning: "Saved, but Azure did not open the port: boom" } });
    const { W } = setup();
    function Probe() {
      const m = useForwardAdd();
      return <button onClick={() => m.mutate({ name: "web" })}>go</button>;
    }
    render(
      <W>
        <Probe />
      </W>,
    );
    act(() => screen.getByText("go").click());
    const warn = await screen.findByText("Saved, but Azure did not open the port: boom");
    expect(warn.closest("[data-kind]")).toHaveAttribute("data-kind", "warning");
    expect(screen.getByText("Published TCP 8080.")).toBeInTheDocument();
  });

  it("shows a refusal as an error toast with the API's message", async () => {
    mockFetch({ "POST /api/v1/deploy": { status: 409, json: { error: { code: "locked", message: "Another run holds the lock." } } } });
    const { W } = setup();
    function Probe() {
      const m = useDeploy();
      return <button onClick={() => m.mutate({})}>go</button>;
    }
    render(
      <W>
        <Probe />
      </W>,
    );
    act(() => screen.getByText("go").click());
    const t = await screen.findByText("Another run holds the lock.");
    expect(t.closest("[data-kind]")).toHaveAttribute("data-kind", "error");
  });

  it("does not toast a field error (the form shows it) and exposes it by field", async () => {
    mockFetch({ "POST /api/v1/destroy": { status: 422, json: { error: { code: "confirm_required", message: 'Type "destroy" to confirm.', field: "confirm" } } } });
    const { W, invalidate } = setup();
    const { result } = renderHook(() => useDestroy(), { wrapper: W });
    await act(async () => {
      await result.current.mutateAsync({ confirm: "nope" }).catch(() => {});
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.fieldError("confirm")).toBe('Type "destroy" to confirm.');
    expect(result.current.fieldError("other")).toBeUndefined();
    expect(screen.queryByText('Type "destroy" to confirm.')).toBeNull();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("is pending (so a form can disable submit) until the server answers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mockFetch({ "POST /api/v1/deploy": async () => (await gate, { ok: true, message: "ok" }) as never });
    const { W } = setup();
    const { result } = renderHook(() => useDeploy(), { wrapper: W });
    act(() => result.current.mutate({}));
    await waitFor(() => expect(result.current.isPending).toBe(true));
    await act(async () => release());
    await waitFor(() => expect(result.current.isPending).toBe(false));
  });

  it("sends the path parameters and verbs for client writes and invalidates clients", async () => {
    const m = mockFetch({ "DELETE /api/v1/clients/4": { ok: true, message: "Deleted x." }, "POST /api/v1/clients": { peer: { id: 9, name: "phone" }, template: "t" } });
    const { W, invalidate } = setup();
    const del = renderHook(() => useDeleteClient(), { wrapper: W });
    await act(async () => {
      await del.result.current.mutateAsync(4);
    });
    expect(m.calls[0]).toMatchObject({ method: "DELETE", url: "/api/v1/clients/4" });
    expect(keys(invalidate)).toContain('["clients"]');

    const add = renderHook(() => useAddClient(), { wrapper: W });
    await act(async () => {
      const out = await add.result.current.mutateAsync({ name: "phone" });
      expect(out.template).toBe("t");
    });
    expect(m.calls[1]).toMatchObject({ method: "POST", url: "/api/v1/clients", body: { name: "phone" } });
    expect(await screen.findByText(/Added phone/)).toBeInTheDocument();
  });

  it("does not toast for an expired session or a lost connection", async () => {
    mockFetch({ "POST /api/v1/deploy": { opaqueRedirect: true } });
    const { W } = setup();
    const { result } = renderHook(() => useDeploy(), { wrapper: W });
    await act(async () => {
      await result.current.mutateAsync({}).catch(() => {});
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("fieldErrorOf", () => {
  it("returns the message only for the matching field of an ApiError", () => {
    const e = new ApiError(400, "bad_input", "Hours must be 0 to 168.", "hours");
    expect(fieldErrorOf(e, "hours")).toBe("Hours must be 0 to 168.");
    expect(fieldErrorOf(e, "region")).toBeUndefined();
    expect(fieldErrorOf(new Error("x"), "hours")).toBeUndefined();
    expect(fieldErrorOf(null, "hours")).toBeUndefined();
  });
});
