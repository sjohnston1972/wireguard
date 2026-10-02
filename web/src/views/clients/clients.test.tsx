import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { clientRoutes } from "./testData";

const table = () => screen.findByRole("table", { name: "Clients" });
const rowNames = (t: HTMLElement) =>
  within(t)
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("cell")[0]!.textContent ?? "");
const rowFor = (t: HTMLElement, name: string) => within(t).getAllByRole("row").find((r) => (within(r).queryAllByRole("cell")[0]?.textContent ?? "").includes(name))!;

// Whole-page journeys: generous time, as the full suite runs many jsdom files at once.
describe("Clients list", { timeout: 20_000 }, () => {
  it("KPI tiles filter the table and show pressed", async () => {
    const user = userEvent.setup();
    renderApp("/clients", { routes: clientRoutes() });
    const t = await table();
    expect(rowNames(t)).toHaveLength(7);

    const full = screen.getByRole("button", { name: /Full-tunnel/ });
    expect(full).toHaveAttribute("aria-pressed", "false");
    await user.click(full);
    expect(full).toHaveAttribute("aria-pressed", "true");
    expect(rowNames(t).join("|")).toMatch(/^phone/);
    expect(rowNames(t)).toHaveLength(1);

    const stale = screen.getByRole("button", { name: /Stale handshakes/ });
    await user.click(stale);
    expect(stale).toHaveAttribute("aria-pressed", "true");
    expect(full).toHaveAttribute("aria-pressed", "false");
    expect(rowNames(t)).toHaveLength(1);
    expect(rowNames(t)[0]).toMatch(/backup-box/);

    // Pressing a pressed tile clears its filter.
    await user.click(stale);
    expect(stale).toHaveAttribute("aria-pressed", "false");
    expect(rowNames(t)).toHaveLength(7);

    await user.click(screen.getByRole("button", { name: /Expiring soon/ }));
    expect(rowNames(t)).toHaveLength(1);
    expect(rowNames(t)[0]).toMatch(/phone/);
  });

  it("filter tabs and search narrow rows by name, address and key", async () => {
    const user = userEvent.setup();
    renderApp("/clients", { routes: clientRoutes() });
    const t = await table();

    const tabs = screen.getByRole("tablist", { name: "Filter clients" });
    expect(within(tabs).getByRole("tab", { name: "All (7)" })).toBeInTheDocument();
    await user.click(within(tabs).getByRole("tab", { name: "Online (2)" }));
    expect(rowNames(t)).toHaveLength(2);
    await user.click(within(tabs).getByRole("tab", { name: "Offline (5)" }));
    expect(rowNames(t)).toHaveLength(5);
    await user.click(within(tabs).getByRole("tab", { name: "Home site (1)" }));
    expect(rowNames(t)[0]).toMatch(/home-site/);
    await user.click(within(tabs).getByRole("tab", { name: "Full tunnel (1)" }));
    expect(rowNames(t)[0]).toMatch(/phone/);
    await user.click(within(tabs).getByRole("tab", { name: "All (7)" }));

    const search = screen.getByRole("searchbox", { name: /Search clients/ });
    await user.click(search);
    await user.paste("lapt");
    expect(rowNames(t)).toEqual([expect.stringMatching(/laptop/)]);
    await user.clear(search);
    await user.click(search);
    await user.paste("10.13.13.12");
    expect(rowNames(t)).toEqual([expect.stringMatching(/build-server/)]);
    await user.clear(search);
    await user.click(search);
    await user.paste("KKKKKKKK");
    expect(rowNames(t)).toEqual([expect.stringMatching(/backup-box/)]);
    await user.clear(search);
    await user.click(search);
    await user.paste("nothing-like-this");
    expect(within(t).getByText(/No clients match/)).toBeInTheDocument();
  });

  it("status words cover disabled, expired and loading onto VM", async () => {
    renderApp("/clients", { routes: clientRoutes() });
    const t = await table();
    expect(within(rowFor(t, "old-tablet")).getByText("Disabled")).toBeInTheDocument();
    expect(within(rowFor(t, "guest-ipad")).getByText("Expired")).toBeInTheDocument();
    expect(within(rowFor(t, "build-server")).getByText("Loading onto VM")).toBeInTheDocument();
    expect(within(rowFor(t, "phone")).getByText("Online")).toBeInTheDocument();
    expect(within(rowFor(t, "laptop")).getByText("Offline")).toBeInTheDocument();
    // After a key rotation, the tag says the device needs its config again.
    expect(within(rowFor(t, "build-server")).getByText("needs new config")).toBeInTheDocument();
    expect(within(rowFor(t, "backup-box")).getByText("stale")).toBeInTheDocument();
  });

  it("offline latency shows a dash, not 0", async () => {
    renderApp("/clients", { routes: clientRoutes() });
    const t = await table();
    const headers = within(t).getAllByRole("columnheader").map((h) => h.textContent);
    const col = headers.findIndex((h) => h?.startsWith("Latency"));
    const latencyOf = (name: string) => within(rowFor(t, name)).getAllByRole("cell")[col]!.textContent;
    expect(latencyOf("laptop")).toMatch(/^—/);
    expect(latencyOf("laptop")).not.toMatch(/\b0\s?ms/);
    expect(latencyOf("phone")).toMatch(/32 ms/);
  });
});
