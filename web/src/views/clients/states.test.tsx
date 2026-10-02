import "./testSetup";
import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { clientRoutes, clientsResponse } from "./testData";

describe("Clients states (spec 10)", { timeout: 20_000 }, () => {
  it("shows a Skeleton shaped like the page while loading", async () => {
    renderApp("/clients", { routes: { ...clientRoutes(), "GET /api/v1/clients": () => new Promise(() => {}) } });
    const busy = await screen.findByLabelText("Loading clients");
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(busy.querySelectorAll(".skeleton--tile")).toHaveLength(6);
    expect(busy.querySelectorAll(".skeleton--row").length).toBeGreaterThan(3);
    expect(screen.queryByRole("table", { name: "Clients" })).not.toBeInTheDocument();
  });

  it("shows the API's message with a working Retry on a 500", async () => {
    const user = userEvent.setup();
    let calls = 0;
    renderApp("/clients", {
      routes: {
        ...clientRoutes(),
        "GET /api/v1/clients": () => (++calls === 1 ? { status: 500, json: { error: { code: "upstream", message: "The database did not answer." } } } : clientsResponse()),
      },
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load the clients");
    expect(alert).toHaveTextContent("The database did not answer.");
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("table", { name: "Clients" })).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it("says what is empty and offers the next action", async () => {
    const user = userEvent.setup();
    renderApp("/clients", { routes: { ...clientRoutes(), "GET /api/v1/clients": clientsResponse({ clients: [], kpis: { total: 0, online: 0, avgLatencyMs: null, fullTunnel: 0, stale: 0, expiringSoon: 0 } }) } });
    const title = await screen.findByText("No clients yet");
    const empty = title.closest(".empty") as HTMLElement;
    expect(empty).toHaveTextContent(/QR code/);
    await user.click(within(empty).getByRole("button", { name: "Add client" }));
    expect(await screen.findByRole("dialog", { name: "Add client" })).toBeInTheDocument();
  });
});
