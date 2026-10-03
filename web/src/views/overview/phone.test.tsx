import "./testSetup";
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { setViewport } from "@/test/viewport";
import { overview, routes } from "./testData";

describe("Overview on the phone", () => {
  it("phone shows the state's main action and opens steps in a sheet", async () => {
    setViewport("phone");
    const user = userEvent.setup();
    const r = renderApp("/", { routes: routes(overview("running")) });
    const page = await screen.findByRole("region", { name: "Environment status" });
    expect(page).toHaveTextContent("Running");
    expect(within(page).getByRole("button", { name: "Extend" })).toHaveClass("ov-phone__main");
    for (const name of ["Hibernate", "Tear down", "Speed", "Move", "Details"]) expect(within(page).getByRole("button", { name })).toBeInTheDocument();
    const lights = within(page).getByRole("list", { name: "Status lights" });
    for (const name of ["Tunnel", "DNS", "Clients online", "Home site"]) expect(within(lights).getByRole("listitem", { name: new RegExp(`^${name}:`) })).toBeInTheDocument();
    // The desktop panels are not drawn on the phone.
    expect(screen.queryByRole("region", { name: "Key metrics" })).toBeNull();
    r.unmount();

    renderApp("/", { routes: routes(overview("deploying")) });
    const p2 = await screen.findByRole("region", { name: "Environment status" });
    expect(p2).toHaveTextContent("Step 7 of 12: Apply Terraform configuration");
    expect(within(p2).getByRole("button", { name: "Cancel deploy" })).toHaveClass("ov-phone__main");
    await user.click(within(p2).getByRole("button", { name: "Steps" }));
    const sheet = await screen.findByRole("dialog", { name: "Steps" });
    expect(within(sheet).getAllByRole("listitem")).toHaveLength(12);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(within(p2).getByRole("button", { name: "Log" }));
    const log = await screen.findByRole("dialog", { name: "Log" });
    expect(within(log).getByRole("log")).toBeInTheDocument();
  });

  it("the Log sheet waits politely for the live log's first lines", async () => {
    setViewport("phone");
    const user = userEvent.setup();
    renderApp("/", { routes: routes(overview("deploying", { snapshot: { log_tail: null } }), { "GET /api/v1/runs/run-dep/log": { log: "", source: "live", active: true, updatedAt: null } }) });
    const page = await screen.findByRole("region", { name: "Environment status" });
    await user.click(within(page).getByRole("button", { name: "Log" }));
    const sheet = await screen.findByRole("dialog", { name: "Log" });
    expect(await within(sheet).findByText("Waiting for the first lines from GitHub Actions…")).toBeInTheDocument();
  });

  it("destroyed: Deploy is the main action and opens the deploy form", async () => {
    setViewport("phone");
    const user = userEvent.setup();
    const r = renderApp("/", { routes: routes(overview("destroyed")) });
    const page = await screen.findByRole("region", { name: "Environment status" });
    await user.click(within(page).getByRole("button", { name: "Deploy" }));
    expect(await screen.findByRole("form", { name: "Deploy" })).toBeInTheDocument();
    expect(r.fetchMock!.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});
