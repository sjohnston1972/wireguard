import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "@/test/render";
import { firewallData, OK } from "./testData";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function rowsByName() {
  const t = await screen.findByRole("table", { name: "Firewall rules" });
  const rows = within(t).getAllByRole("row").slice(1);
  return (name: string) => rows.find((r) => r.getAttribute("data-rule-name") === name)!;
}
const moves = (fetchMock: ReturnType<typeof renderApp>["fetchMock"]) => fetchMock!.calls.filter((c) => c.method === "POST" && /\/firewall\/draft\/rules\/\d+\/move$/.test(c.url));

describe("reordering rules", () => {
  it("drag to a new place sends one move with to", async () => {
    const { fetchMock } = renderApp("/firewall", { routes: { "GET /api/v1/firewall": firewallData(), "POST /api/v1/firewall/draft/rules/1/move": OK } });
    const row = await rowsByName();
    const handle = within(row("Clients to the Azure VNet")).getByTitle("Drag to reorder Clients to the Azure VNet");
    const target = row("Web to the test server");
    fireEvent.dragStart(handle);
    fireEvent.dragEnter(row("Clients to the internet (full tunnel)"));
    fireEvent.dragOver(row("Clients to the internet (full tunnel)"));
    fireEvent.dragEnter(target);
    expect(fireEvent.dragOver(target)).toBe(false); // a drop target: the browser is told a drop is allowed
    fireEvent.drop(target);
    fireEvent.dragEnd(handle);
    await waitFor(() => expect(moves(fetchMock)).toHaveLength(1));
    expect(moves(fetchMock)[0].url).toBe("/api/v1/firewall/draft/rules/1/move");
    expect(moves(fetchMock)[0].body).toEqual({ to: 2 });
  });

  it("dropping in place sends nothing", async () => {
    const { fetchMock } = renderApp("/firewall", { routes: { "GET /api/v1/firewall": firewallData() } });
    const row = await rowsByName();
    const r2 = row("Clients to the internet (full tunnel)");
    const handle = within(r2).getByTitle(/drag to reorder/i);
    fireEvent.dragStart(handle);
    fireEvent.dragEnter(r2);
    fireEvent.dragOver(r2);
    fireEvent.drop(r2);
    fireEvent.dragEnd(handle);
    // A drop with no drag in progress (from outside the table) does nothing either.
    fireEvent.drop(row("Block old printer"));
    await new Promise((r) => setTimeout(r, 50));
    expect(moves(fetchMock)).toHaveLength(0);
  });

  it("keyboard reorder with Alt+Arrow sends dir and keeps focus on the row", async () => {
    let moved = false;
    const swapped = () => {
      const d = firewallData();
      const [a, b, ...rest] = d.rules;
      return { ...d, rules: [a, { ...rest[0], place: 2 }, { ...b, place: 3 }, ...rest.slice(1)] };
    };
    const { fetchMock } = renderApp("/firewall", {
      routes: {
        "GET /api/v1/firewall": () => (moved ? swapped() : firewallData()),
        "POST /api/v1/firewall/draft/rules/2/move": () => {
          moved = true;
          return OK;
        },
      },
    });
    const row = await rowsByName();
    const r2 = row("Clients to the internet (full tunnel)");
    act(() => r2.focus());
    fireEvent.keyDown(r2, { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(moves(fetchMock)).toHaveLength(1));
    expect(moves(fetchMock)[0].body).toEqual({ dir: "down" });
    // The refreshed list puts the rule third, and focus stays on it.
    await waitFor(async () => {
      const t = screen.getByRole("table", { name: "Firewall rules" });
      expect(within(t).getAllByRole("row")[3]).toHaveAttribute("data-rule-name", "Clients to the internet (full tunnel)");
    });
    await waitFor(() => expect(document.activeElement).toHaveAttribute("data-rule-name", "Clients to the internet (full tunnel)"));
    // The first rule cannot go further up: nothing is sent.
    const first = (await rowsByName())("Clients to the Azure VNet");
    act(() => first.focus());
    fireEvent.keyDown(first, { key: "ArrowUp", altKey: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(moves(fetchMock)).toHaveLength(1);
  });

  it("the default row is not a drop target", async () => {
    const { fetchMock } = renderApp("/firewall", { routes: { "GET /api/v1/firewall": firewallData() } });
    const row = await rowsByName();
    const handle = within(row("Clients to the Azure VNet")).getByTitle(/drag to reorder/i);
    const def = row("Default (catch all)");
    fireEvent.dragStart(handle);
    fireEvent.dragEnter(def);
    expect(fireEvent.dragOver(def)).toBe(true); // not prevented: the browser shows "no drop"
    fireEvent.drop(def);
    fireEvent.dragEnd(handle);
    // And Alt+Arrow on the default row moves nothing.
    act(() => def.focus());
    fireEvent.keyDown(def, { key: "ArrowUp", altKey: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(moves(fetchMock)).toHaveLength(0);
  });

  it("Move down in a rule's menu sends one move with dir", async () => {
    const { fetchMock } = renderApp("/firewall", { routes: { "GET /api/v1/firewall": firewallData(), "POST /api/v1/firewall/draft/rules/3/move": OK } });
    await rowsByName();
    const trigger = screen.getByRole("button", { name: "Actions for Web to the test server" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move down" }));
    await waitFor(() => expect(moves(fetchMock)).toHaveLength(1));
    expect(moves(fetchMock)[0].body).toEqual({ dir: "down" });
  });
});
