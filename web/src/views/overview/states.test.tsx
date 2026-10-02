import "./testSetup";
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { activity, overview, routes } from "./testData";

describe("Overview states (spec §10)", () => {
  it("shows a page-shaped skeleton while the overview loads", async () => {
    renderApp("/", { routes: routes(overview("running"), { "GET /api/v1/overview": () => new Promise(() => {}) }) });
    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
    const loading = await within(main).findByLabelText("Loading the overview");
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(loading.querySelectorAll(".skeleton").length).toBeGreaterThanOrEqual(5);
    expect(within(main).queryByRole("region", { name: "Status" })).toBeNull();
  });

  it("shows the API's message with a Retry that works on a 500", async () => {
    const user = userEvent.setup();
    let fail = true;
    renderApp("/", {
      routes: routes(overview("running"), {
        "GET /api/v1/overview": () => (fail ? { status: 500, json: { error: { code: "internal", message: "The overview broke." } } } : overview("running")),
      }),
    });
    const alert = await within(screen.getByRole("main")).findByRole("alert");
    expect(alert).toHaveTextContent("The overview broke.");
    fail = false;
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("region", { name: "Status" })).toHaveTextContent("Running");
  });

  it("names what is empty and offers the next action", async () => {
    const user = userEvent.setup();
    const empty = { ...activity(), all: [] };
    renderApp("/", { routes: routes(overview("destroyed"), { "GET /api/v1/activity": empty }) });
    const last = await screen.findByRole("region", { name: "Last run" });
    expect(last).toHaveTextContent("No run steps to show");
    expect(within(last).getByRole("link", { name: "Activity" })).toHaveAttribute("href", "/activity");
    const events = screen.getByRole("region", { name: "Recent events" });
    await waitFor(() => expect(events).toHaveTextContent("No events in the last 24 h"));
    await user.click(within(last).getByRole("button", { name: "Deploy" }));
    expect(await screen.findByRole("dialog", { name: "Deploy" })).toBeInTheDocument();
  });
});
