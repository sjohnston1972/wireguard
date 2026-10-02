import "./slow";
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "@/test/render";
import { setViewport } from "@/test/viewport";
import { routesFor } from "./testkit";

describe("Settings on the phone", () => {
  it("phone lists seven sections that open sheets", async () => {
    setViewport("phone");
    const user = userEvent.setup();
    renderApp("/settings", { routes: routesFor() });
    const list = await screen.findByRole("list", { name: "Settings sections" });
    const names = within(list).getAllByRole("button").map((b) => b.querySelector(".set-phone-list__name")?.textContent);
    expect(names).toEqual(["Overview", "Deployment", "Automation", "Security", "Backup & Recovery", "Mobile", "Maintenance"]);
    // The section tab bar is a desktop thing.
    expect(screen.queryByRole("tab")).toBeNull();

    await user.click(within(list).getByRole("button", { name: /Deployment/ }));
    const sheet = await screen.findByRole("dialog", { name: "Deployment" });
    expect(within(sheet).getByRole("switch", { name: /Test VM/ })).toBeInTheDocument();
    expect(screen.getByLabelText("location")).toHaveTextContent("/settings/deployment");

    await user.click(within(sheet).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByLabelText("location")).toHaveTextContent(/^\/settings$/);
  });

  it("closing a sheet with unsaved changes asks first", async () => {
    setViewport("phone");
    const user = userEvent.setup();
    renderApp("/settings/automation", { routes: routesFor() });
    const sheet = await screen.findByRole("dialog", { name: "Automation" });
    const idle = within(sheet).getByLabelText(/Idle limit/);
    await user.clear(idle);
    await user.type(idle, "20");
    await user.click(within(sheet).getByRole("button", { name: "Close" }));
    expect(await screen.findByRole("dialog", { name: /Leave without saving/ })).toBeInTheDocument();
    expect(screen.getByLabelText("location")).toHaveTextContent("/settings/automation");
  });

  it("an unknown section on the phone falls back to the list", async () => {
    setViewport("phone");
    renderApp("/settings/nonsense", { routes: routesFor() });
    expect(await screen.findByRole("list", { name: "Settings sections" })).toBeInTheDocument();
    expect(screen.getByLabelText("location")).toHaveTextContent(/^\/settings$/);
  });
});
